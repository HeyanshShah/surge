import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { City, type CityData } from './city';
import { cadPolicy, cadRoutedPolicy, fifoPolicy, surgePolicy } from './dispatch';
import { FloodModel } from './flood';
import { Router } from './routing';
import { makeScenario } from './scenario';
import { type Metrics, type Policy, Sim, defaultFleet } from './sim';
import { Triager } from './triage';
import { TYPE_LABEL } from './types';
import { makeState, refresh, serve, status } from './live/server';

const HELP = `surge - a 911 dispatch copilot for flood emergencies

usage:
  surge live [--hours 6] [--save snapshot.json]            live river gauges + NOAA forecasts -> flood outlook for the city right now
  surge serve [--port 8080] [--data dir] [--host 0.0.0.0 --tokens name:token,...]
                                                           live console and JSON API for a dispatch center
                                                           --data keeps a journal so restarts lose nothing; --tokens (or SURGE_TOKENS) is
                                                           required off localhost; --gauges snapshot.json replays a saved snapshot offline
  surge bench [--seeds 10] [--from 101] [--json out.json]  compare dispatch policies over many simulated storms (Harvey replay)
  surge triage "<what the caller said>"                    triage one call against the city's real addresses
  surge calls [--seed 1] [--n 12]                          print sample calls from a scenario

every command takes --city <file.json> (default data/houston.json; build another city with data/build.py)
`;

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
}

function sarg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function loadCity(): City {
  const given = sarg('city');
  if (given) return new City(JSON.parse(readFileSync(given, 'utf8')) as CityData);
  const here = dirname(fileURLToPath(import.meta.url));
  const path = [join(here, '../data/houston.json'), join(here, '../../data/houston.json')].find((p) => {
    try {
      readFileSync(p, { flag: 'r' });
      return true;
    } catch {
      return false;
    }
  });
  if (!path) throw new Error('data/houston.json not found; run `npm run data` first');
  return new City(JSON.parse(readFileSync(path, 'utf8')) as CityData);
}

function bench(): void {
  const seeds = arg('seeds', 10);
  const from = arg('from', 101);
  const intensity = arg('intensity', 1);
  const city = loadCity();
  const flood = new FloodModel(city);
  const router = new Router(city, flood);
  const fleet = defaultFleet(city);
  const policies: (() => Policy)[] = [
    fifoPolicy,
    cadPolicy,
    cadRoutedPolicy,
    () => surgePolicy(city, { forecast: false, name: 'Surge, no flood forecast' }),
    () => surgePolicy(city),
  ];
  const rows = new Map<string, Metrics[]>();
  console.log(`${city.name}: ${city.n} road nodes, ${city.m} road links, ${city.addresses.length} addresses, ${fleet.length} units`);
  for (let s = from; s < from + seeds; s++) {
    const sc = makeScenario(city, flood, { seed: s, intensity });
    const line: string[] = [];
    for (const mk of policies) {
      const p = mk();
      const m = new Sim(city, flood, sc, p, fleet, router).run();
      if (!rows.has(p.name)) rows.set(p.name, []);
      rows.get(p.name)!.push(m);
      line.push(`${p.name.split(' ')[0]} ${m.deaths.toFixed(1)}`);
    }
    console.log(`storm ${s}: ${sc.incidents.length} emergencies, ${sc.calls.length} potential calls | deaths  ${line.join('  ')}`);
  }
  const cols: [string, (m: Metrics) => number, number][] = [
    ['deaths', (m) => m.deaths, 1],
    ['reached', (m) => m.incidentsServed, 0],
    ['P1 median min', (m) => m.p1ResponseMedian, 1],
    ['P1 p90 min', (m) => m.p1ResponseP90, 1],
    ['P1 never reached', (m) => m.p1Unreached, 1],
    ['turned back', (m) => m.turnedBack, 0],
    ['wasted trips', (m) => m.duplicateTrips + m.wrongLocationTrips, 1],
    ['repeat calls', (m) => m.repeatCalls, 0],
    ['hung up on hold', (m) => m.callsAbandoned, 0],
  ];
  console.log(`\nmean over ${seeds} storms (95% CI for deaths)`);
  console.log(['policy'.padEnd(26), ...cols.map(([h]) => h.padStart(16))].join(''));
  const base = mean(rows.get('Standard CAD')!.map((m) => m.deaths));
  for (const [name, ms] of rows) {
    const d = ms.map((m) => m.deaths);
    const cells = cols.map(([, f, dp], i) => {
      const v = mean(ms.map(f));
      return (i === 0 ? `${v.toFixed(1)} ±${ci(d).toFixed(1)}` : v.toFixed(dp)).padStart(16);
    });
    console.log([name.padEnd(26), ...cells].join(''));
  }
  const surge = mean(rows.get('Surge copilot')!.map((m) => m.deaths));
  const routed = mean(rows.get('CAD + flood routing')!.map((m) => m.deaths));
  console.log(`\nSurge copilot vs standard CAD: ${(100 * (1 - surge / base)).toFixed(0)}% fewer deaths; vs CAD + flood routing: ${(100 * (1 - surge / routed)).toFixed(0)}% fewer`);
  const out = process.argv.indexOf('--json');
  if (out > 0) {
    const summary = {
      seeds,
      from,
      units: fleet.length,
      rows: [...rows].map(([policy, ms]) => ({
        policy,
        deaths: mean(ms.map((m) => m.deaths)),
        ci: ci(ms.map((m) => m.deaths)),
        reached: mean(ms.map((m) => m.incidentsServed)),
        p1Median: mean(ms.map((m) => m.p1ResponseMedian)),
        p1P90: mean(ms.map((m) => m.p1ResponseP90)),
        p1Unreached: mean(ms.map((m) => m.p1Unreached)),
        turnedBack: mean(ms.map((m) => m.turnedBack)),
        wasted: mean(ms.map((m) => m.duplicateTrips + m.wrongLocationTrips)),
        repeat: mean(ms.map((m) => m.repeatCalls)),
        abandoned: mean(ms.map((m) => m.callsAbandoned)),
      })),
    };
    writeFileSync(process.argv[out + 1], JSON.stringify(summary, null, 1));
    console.log(`wrote ${process.argv[out + 1]}`);
  }
}

function triage(): void {
  const text = process.argv.slice(3).join(' ');
  if (!text) return void console.log(HELP);
  const city = loadCity();
  const flood = new FloodModel(city);
  const t0 = performance.now();
  const r = new Triager(city).triage(text);
  const ms = performance.now() - t0;
  console.log(`${TYPE_LABEL[r.type]}  (acuity ${r.acuity}, confidence ${(r.confidence * 100).toFixed(0)}%, ${ms.toFixed(2)} ms)`);
  console.log(`where:   ${r.address ? `${r.address.number} ${r.address.street}` : 'no address heard, use phone location'}`);
  console.log(`who:     ${r.people} ${r.people === 1 ? 'person' : 'people'}${Object.entries(r.vuln).filter(([, v]) => v).map(([k]) => `, ${k}`).join('')}`);
  if (r.reportedDepth !== null) console.log(`water:   caller reports ~${r.reportedDepth} m`);
  if (r.address) {
    const crit = flood.timeToDepth(r.address.x, r.address.y, 1.2);
    console.log(`forecast: ${Number.isFinite(crit) ? `water reaches 1.2 m here at ${clock(crit)}` : 'this address stays below 1.2 m tonight'}`);
  }
  console.log('evidence:');
  for (const e of r.evidence) console.log(`  "${e.text}" -> ${e.label}`);
}

function calls(): void {
  const city = loadCity();
  const flood = new FloodModel(city);
  const sc = makeScenario(city, flood, { seed: arg('seed', 1) });
  for (const c of sc.calls.slice(0, arg('n', 12))) console.log(`${clock(c.t)}  ${c.transcript}`);
}

/** Scenario minutes to wall-clock time on the night of Aug 26-27, 2017 (starts 22:00). */
export function clock(t: number): string {
  const m = Math.round(22 * 60 + t) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function mean(a: number[]): number {
  return a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
}

function ci(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  return (1.96 * sd) / Math.sqrt(a.length);
}

async function live(): Promise<void> {
  const city = loadCity();
  const hours = arg('hours', 6);
  const state = makeState(city);
  console.log(`${city.name}: fetching live gauges from USGS and forecasts from NOAA...`);
  await refresh(state);
  const save = sarg('save');
  if (save && state.report) {
    writeFileSync(save, JSON.stringify(state.report));
    console.log(`saved the gauge snapshot to ${save} (replay it with: surge serve --gauges ${save})`);
  }
  const st = status(state);
  for (const e of st.errors) console.log(`  ! ${e}`);
  if (state.source !== 'live') return void console.log('No live gauge data reachable; nothing to forecast.');
  console.log(`\n${st.gauges.length} gauges (${st.gauges.filter((g) => g.forecast).length} with NOAA forecasts):`);
  for (const g of st.gauges) {
    const fc = g.forecast ? `  forecast peak ${g.forecast.peakFt.toFixed(1)} ft ${new Date(g.forecast.peakAt).toLocaleString()} (${g.forecast.category})` : '';
    console.log(`  ${g.name.padEnd(48).slice(0, 48)} ${g.latestFt.toFixed(1).padStart(6)} ft  ${g.trendFt >= 0 ? '+' : ''}${g.trendFt.toFixed(1)} ft/3h  ${g.category}${fc}`);
  }
  const c = state.center;
  for (const [label, t] of [['now', c.now()], [`in ${hours} h`, c.now() + hours * 60]] as const) {
    const r = c.readiness(t, c.now() + hours * 60);
    console.log(`\n${label}: ${r.closedKm.car.toFixed(0)} km of road closed to cars, ${r.closedKm.highwater.toFixed(0)} km to high-water trucks (of ${r.totalKm.toFixed(0)} km)`);
    console.log(`  ${r.addresses.stall} of ${r.addresses.total} sampled addresses with car-stalling water, ${r.addresses.chest} chest-deep`);
    if (r.stationsCutOff.length) console.log(`  stations cut off: ${r.stationsCutOff.join(', ')}`);
    if (label !== 'now' && r.firstStreets.length) console.log(`  stage boats near: ${r.firstStreets.slice(0, 6).map((s) => s.street).join(', ')}`);
  }
}

const cmd = process.argv[2];
if (cmd === 'live') void live();
else if (cmd === 'serve') {
  const given = sarg('city');
  const page = given && !given.endsWith('houston.json') ? `surge-${basename(given, '.json')}.html` : 'surge.html';
  const html = sarg('html') ?? join(dirname(fileURLToPath(import.meta.url)), page);
  const spec = sarg('tokens') ?? process.env.SURGE_TOKENS;
  const tokens = spec ? new Map(spec.split(',').map((p) => p.split(':').reverse() as [string, string])) : undefined;
  serve(loadCity(), { port: arg('port', 8080), html, gauges: sarg('gauges'), host: sarg('host'), data: sarg('data'), tokens }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (cmd === 'bench') bench();
else if (cmd === 'triage') triage();
else if (cmd === 'calls') calls();
else console.log(HELP);
