import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { City, type CityData } from '../src/city';
import { FloodModel, Hydrograph } from '../src/flood';
import { LiveCenter } from '../src/live/center';
import { type Gauge, driveFromGauges, fetchGauges, gaugeCurve, lonLatToXY, parseNwpsGauge, parseNwpsGauges, parseNwpsStageflow, parseUsgsIv, summarize } from '../src/live/gauges';
import { handle, makeState } from '../src/live/server';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
let city: City;

beforeAll(() => {
  city = new City(JSON.parse(readFileSync(new URL('../data/houston.json', import.meta.url), 'utf8')) as CityData);
});

describe('live gauge feeds', () => {
  it('parses USGS instantaneous values and drops missing readings', () => {
    const g = parseUsgsIv(fx('usgs-iv.json'));
    expect(g.map((x) => x.id)).toEqual(['08074000', '08075000']);
    expect(g[0].name).toBe('Buffalo Bayou at Houston, TX');
    expect(g[0].observed.length).toBe(23);
    expect(g[0].observed[0]).toEqual({ t: Date.parse('2026-10-10T19:30:00-05:00'), ft: 7.01 });
    expect(g[0].observed.every((r) => r.ft > 0)).toBe(true);
  });

  it('parses NOAA gauges, flood categories and forecasts, skipping -999 placeholders', () => {
    expect(parseNwpsGauges(fx('nwps-gauges.json')).map((g) => g.lid)).toEqual(['BBST2', 'HBMT2', 'GSST2']);
    expect(parseNwpsGauge(fx('nwps-gauge-HBMT2.json'))).toEqual({ usgsId: '08075000', flood: { action: 36, minor: 41, moderate: 46, major: 51 } });
    const sf = parseNwpsStageflow(fx('nwps-stageflow-HBMT2.json'));
    expect(sf.observed.length).toBe(6);
    expect(sf.forecast.map((r) => r.ft)).toEqual([12, 20, 24]);
  });

  it('joins NOAA forecasts onto USGS gauges and survives a source being down', async () => {
    const routes: [RegExp, string][] = [
      [/waterservices/, 'usgs-iv.json'],
      [/gauges\?/, 'nwps-gauges.json'],
      [/gauges\/HBMT2$/, 'nwps-gauge-HBMT2.json'],
      [/gauges\/HBMT2\/stageflow$/, 'nwps-stageflow-HBMT2.json'],
    ];
    const fetch = async (url: string) => {
      const hit = routes.find(([re]) => re.test(url));
      return hit ? { ok: true, status: 200, json: async () => fx(hit[1]) } : { ok: false, status: 404, json: async () => null };
    };
    const r = await fetchGauges([-95.56, 29.62, -95.3, 29.82], { fetch });
    const brays = r.gauges.find((g) => g.usgsId === '08075000')!;
    expect(brays.nwsId).toBe('HBMT2');
    expect(brays.forecast.length).toBe(3);
    expect(brays.flood?.minor).toBe(41);
    expect(r.gauges.length).toBe(2);
    expect(r.errors.some((e) => e.includes('BBST2'))).toBe(true);

    const down = await fetchGauges([-95.56, 29.62, -95.3, 29.82], { fetch: async (url: string) => (/waterservices/.test(url) ? fetch(url) : Promise.reject(new Error('offline'))) });
    expect(down.gauges.length).toBe(2);
    expect(down.errors[0]).toMatch(/NOAA/);
  });

  it('turns a gauge into a stage curve above base flow that follows the NOAA forecast', () => {
    const t0 = Date.parse('2026-10-12T00:00:00Z');
    const g: Gauge = {
      id: 'x',
      name: 'x',
      lon: 0,
      lat: 0,
      observed: [0, 1, 2, 3].map((h) => ({ t: t0 + h * 3600e3, ft: 5 + h })),
      forecast: [3, 6, 12, 48].map((h) => ({ t: t0 + h * 3600e3, ft: [8, 14, 20, 10][[3, 6, 12, 48].indexOf(h)] })),
    };
    const c = gaugeCurve(g, t0);
    expect(c.stage(0)).toBeCloseTo(0);
    expect(c.stage(180)).toBeCloseTo(3 * 0.3048);
    expect(c.stage(12 * 60)).toBeCloseTo(15 * 0.3048);
    // without a forecast it holds the latest reading instead of inventing a trend
    const flat = gaugeCurve({ ...g, forecast: [] }, t0);
    expect(flat.stage(48 * 60)).toBeCloseTo(3 * 0.3048);
    const s = summarize(g);
    expect(s.trendFt).toBeCloseTo(3);
    expect(s.forecast?.peakFt).toBe(20);
  });
});

describe('flood model driven by gauges', () => {
  it('floods only the bayou whose gauge is rising', () => {
    const t0 = Date.parse('2026-10-12T00:00:00Z');
    const hrs = (h: number) => t0 + h * 3600e3;
    const rising: Gauge = { id: 'brays', name: 'Brays', lon: -95.41216, lat: 29.69717, observed: [0, 6].map((h) => ({ t: hrs(h), ft: 5 + h * 3 })), forecast: [] };
    const calm: Gauge = { id: 'buffalo', name: 'Buffalo', lon: -95.4085505, lat: 29.76022829, observed: [0, 6].map((h) => ({ t: hrs(h), ft: 7 })), forecast: [] };
    const flood = new FloodModel(city, [new Hydrograph([[0, 0]])]);
    const cov = driveFromGauges(flood, [rising, calm], t0);
    expect(cov.gauges.every((g) => g.snapped)).toBe(true);
    expect(cov.networked).toBeGreaterThan(cov.nearest);
    // cells where the water came up by more than 0.3 m
    let wetBrays = 0;
    let wetBuffalo = 0;
    for (let c = 0; c < flood.channel.length; c++) {
      if (flood.depthCell(c, 6 * 60) - flood.depthCell(c, 0) <= 0.3) continue;
      if (flood.channel[c] === 0) wetBrays++;
      else wetBuffalo++;
    }
    expect(wetBrays).toBeGreaterThan(100);
    expect(wetBuffalo).toBe(0);
    // a point right by the rising gauge is wetter at hour 6 than at hour 0
    const [x, y] = lonLatToXY(city, rising.lon, rising.lat);
    expect(flood.depthAt(x, y, 360)).toBeGreaterThanOrEqual(flood.depthAt(x, y, 0));
  });
});

describe('live dispatch center', () => {
  it('takes calls, merges repeats, recommends a boat into deep water, and remembers turn-backs', () => {
    let clock = Date.parse('2026-10-12T00:00:00Z');
    const flood = new FloodModel(city, [new Hydrograph([[0, 4.5]])]);
    const center = new LiveCenter(city, flood, clock, { clock: () => clock });
    const a = center.call({ text: "we're on the roof with two kids, water is up to the gutters, 5607 pardee street", phone: '713-555-0101' });
    expect(a.merged).toBe(false);
    expect(a.incident.type).toBe('water_rescue');
    clock += 5 * 60000;
    const b = center.call({ text: 'please we called already, the water is still rising', phone: '713-555-0101' });
    expect(b.merged).toBe(true);
    expect(a.incident.calls.length).toBe(2);
    const recs = center.recommend();
    const r = recs.find((x) => x.incident === a.incident.id)!;
    expect(r).toBeTruthy();
    expect(center.units[r.unit].vehicle).not.toBe('car');
    expect(r.route && r.route.length).toBeGreaterThan(2);
    center.dispatch(r.unit, r.incident);
    expect(() => center.dispatch(r.unit, r.incident)).toThrow();
    const vehicle = center.units[r.unit].vehicle;
    center.setUnit(r.unit, 'turned_back');
    expect(a.incident.status).toBe('waiting');
    const again = center.recommend(false).find((x) => x.incident === a.incident.id);
    if (again) expect(center.units[again.unit].vehicle).not.toBe(vehicle);
    const ready = center.readiness(center.now());
    expect(ready.closedKm.car).toBeGreaterThan(ready.closedKm.highwater);
    expect(ready.addresses.chest).toBeGreaterThan(0);
  });

  it('serves the same board over the HTTP API', async () => {
    const state = makeState(city);
    const q = new URLSearchParams();
    const [code, body] = await handle(state, 'POST', '/api/calls', q, { text: 'my husband collapsed and is not breathing, 4810 north braeswood' });
    expect(code).toBe(201);
    expect((body as { incident: { type: string } }).incident.type).toBe('cardiac_arrest');
    const [, recs] = await handle(state, 'GET', '/api/recommendations', q, null);
    expect((recs as { unitName: string }[])[0].unitName).toMatch(/Medic|Engine/);
    const [sc, st] = await handle(state, 'POST', '/api/scenario', q, { rise: 3, hours: 6 });
    expect(sc).toBe(200);
    expect((st as { source: string }).source).toBe('scenario');
    await expect(handle(state, 'POST', '/api/calls', q, {})).rejects.toThrow(/text/);
  });
});
