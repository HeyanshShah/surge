import type { City } from '../city';
import { type FloodModel, Hydrograph, type StageCurve } from '../flood';
import { NumHeap } from '../heap';

/**
 * Live river gauges: USGS instantaneous gage height (observations every 5 to 15 minutes) and the
 * National Water Prediction Service (NOAA) official stage forecasts and flood categories.
 * Both are free public APIs with no key. Each gauge becomes a stage curve for the bayou reaches it watches.
 */

export interface Reading {
  /** Unix milliseconds. */
  t: number;
  /** Stage in feet, as both agencies publish it. */
  ft: number;
}

export interface Gauge {
  /** USGS site number when there is one, otherwise the NWS location id. */
  id: string;
  name: string;
  lon: number;
  lat: number;
  usgsId?: string;
  nwsId?: string;
  observed: Reading[];
  /** NOAA official forecast, usually 2 to 5 days at 6-hour steps; empty where NOAA issues none. */
  forecast: Reading[];
  /** NWS flood categories (stage in feet). */
  flood?: { action?: number; minor?: number; moderate?: number; major?: number };
}

export type BBox = [west: number, south: number, east: number, north: number];

export const USGS_IV = 'https://waterservices.usgs.gov/nwis/iv/';
export const NWPS = 'https://api.water.noaa.gov/nwps/v1';
const FT = 0.3048;
const MISSING = -900;

// ------------------------------------------------------------------ parsing

/** USGS NWIS instantaneous values (WaterML-JSON), parameter 00065 gage height. */
export function parseUsgsIv(json: unknown): Gauge[] {
  const series = (json as { value?: { timeSeries?: unknown[] } })?.value?.timeSeries ?? [];
  const out: Gauge[] = [];
  for (const raw of series) {
    const ts = raw as {
      sourceInfo: { siteName: string; siteCode: { value: string }[]; geoLocation: { geogLocation: { latitude: number; longitude: number } } };
      variable?: { noDataValue?: number };
      values: { value: { value: string; dateTime: string }[] }[];
    };
    const site = ts.sourceInfo?.siteCode?.[0]?.value;
    if (!site) continue;
    const noData = ts.variable?.noDataValue ?? -999999;
    const observed: Reading[] = [];
    for (const block of ts.values ?? [])
      for (const v of block.value ?? []) {
        const ft = Number(v.value);
        const t = Date.parse(v.dateTime);
        if (Number.isFinite(ft) && ft !== noData && ft > MISSING && Number.isFinite(t)) observed.push({ t, ft });
      }
    observed.sort((a, b) => a.t - b.t);
    const g = ts.sourceInfo.geoLocation.geogLocation;
    // one site can report several sensors; keep the longest record
    const prev = out.find((o) => o.id === site);
    if (prev) {
      if (observed.length > prev.observed.length) prev.observed = observed;
      continue;
    }
    out.push({ id: site, usgsId: site, name: tidy(ts.sourceInfo.siteName), lon: g.longitude, lat: g.latitude, observed, forecast: [] });
  }
  return out;
}

export interface NwpsGaugeRef {
  lid: string;
  name: string;
  lat: number;
  lon: number;
}

/** NWPS gauge list for a bounding box. */
export function parseNwpsGauges(json: unknown): NwpsGaugeRef[] {
  const list = (json as { gauges?: { lid: string; name: string; latitude: number; longitude: number }[] })?.gauges ?? [];
  return list.filter((g) => g.lid).map((g) => ({ lid: g.lid, name: tidy(g.name), lat: g.latitude, lon: g.longitude }));
}

/** NWPS gauge metadata: the matching USGS site and the flood categories. */
export function parseNwpsGauge(json: unknown): { usgsId?: string; flood: Gauge['flood'] } {
  const g = json as { usgsId?: string; flood?: { categories?: Record<string, { stage?: number }> } };
  const cat = g?.flood?.categories ?? {};
  const st = (k: string) => {
    const v = cat[k]?.stage;
    return typeof v === 'number' && v > MISSING ? v : undefined;
  };
  return { usgsId: g?.usgsId || undefined, flood: { action: st('action'), minor: st('minor'), moderate: st('moderate'), major: st('major') } };
}

/** NWPS stage/flow series: observed and forecast stage in feet. */
export function parseNwpsStageflow(json: unknown): { observed: Reading[]; forecast: Reading[] } {
  const j = json as { observed?: { data?: { validTime: string; primary: number }[] }; forecast?: { data?: { validTime: string; primary: number }[] } };
  const read = (d?: { validTime: string; primary: number }[]) =>
    (d ?? [])
      .map((r) => ({ t: Date.parse(r.validTime), ft: r.primary }))
      .filter((r) => Number.isFinite(r.t) && typeof r.ft === 'number' && r.ft > MISSING)
      .sort((a, b) => a.t - b.t);
  return { observed: read(j?.observed?.data), forecast: read(j?.forecast?.data) };
}

function tidy(name: string): string {
  return (name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b(tx|la|fl|nc|sc|ny|nj|va|ga|al|ms|ca|pa)\b/g, (s) => s.toUpperCase())
    .replace(/\b([a-z])/g, (s) => s.toUpperCase())
    .replace(/\bAt\b/g, 'at')
    .replace(/\bNr\b/g, 'near')
    .replace(/\bBlw\b/g, 'below')
    .replace(/\bAbv\b/g, 'above');
}

// ------------------------------------------------------------------ fetching

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FetchReport {
  gauges: Gauge[];
  fetchedAt: number;
  errors: string[];
}

/**
 * Every stage gauge in (a margin around) the box, with NOAA forecasts joined on where NOAA issues them.
 * Each source fails independently: USGS alone is enough to run, and NOAA alone gives forecasts.
 */
export async function fetchGauges(bbox: BBox, opts: { fetch?: Fetch; days?: number; maxForecastGauges?: number; timeoutMs?: number } = {}): Promise<FetchReport> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
  const pad = 0.04;
  const [w, s, e, n] = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad].map((v) => v.toFixed(4));
  const errors: string[] = [];
  const get = async (url: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20000);
    try {
      const r = await f(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const usgsUrl = `${USGS_IV}?format=json&bBox=${w},${s},${e},${n}&parameterCd=00065&siteStatus=active&period=P${opts.days ?? 7}D`;
  const nwpsUrl = `${NWPS}/gauges?bbox.xmin=${w}&bbox.ymin=${s}&bbox.xmax=${e}&bbox.ymax=${n}&srid=EPSG_4326`;
  const [usgs, refs] = await Promise.all([
    get(usgsUrl).then(parseUsgsIv, (err) => (errors.push(`USGS: ${err.message ?? err}`), [] as Gauge[])),
    get(nwpsUrl).then(parseNwpsGauges, (err) => (errors.push(`NOAA: ${err.message ?? err}`), [] as NwpsGaugeRef[])),
  ]);
  const gauges = usgs;
  const detail = await Promise.all(
    refs.slice(0, opts.maxForecastGauges ?? 30).map(async (r) => {
      try {
        const [meta, sf] = await Promise.all([get(`${NWPS}/gauges/${r.lid}`).then(parseNwpsGauge), get(`${NWPS}/gauges/${r.lid}/stageflow`).then(parseNwpsStageflow)]);
        return { r, meta, sf };
      } catch (err) {
        errors.push(`NOAA ${r.lid}: ${(err as Error).message ?? err}`);
        return null;
      }
    }),
  );
  for (const d of detail) {
    if (!d) continue;
    const match = gauges.find((g) => (d.meta.usgsId && g.usgsId === d.meta.usgsId) || Math.hypot(g.lon - d.r.lon, g.lat - d.r.lat) < 0.002);
    if (match) {
      match.nwsId = d.r.lid;
      match.forecast = d.sf.forecast;
      match.flood = d.meta.flood;
      if (!match.observed.length) match.observed = d.sf.observed;
    } else if (d.sf.observed.length) {
      gauges.push({ id: d.r.lid, nwsId: d.r.lid, usgsId: d.meta.usgsId, name: d.r.name, lon: d.r.lon, lat: d.r.lat, observed: d.sf.observed, forecast: d.sf.forecast, flood: d.meta.flood });
    }
  }
  return { gauges: gauges.filter((g) => g.observed.length >= 2), fetchedAt: Date.now(), errors };
}

// ------------------------------------------------------------------ gauges to stage curves

/**
 * Stage above normal, in meters, as a curve over minutes since `epoch`.
 * "Normal" is the lowest reading of the record (a few days of base flow before the event), which is the level the
 * channel cells of the terrain model sit at. After the last observation the curve follows NOAA's forecast where
 * there is one, and otherwise holds the latest reading (persistence), so it never invents a rise.
 */
export function gaugeCurve(g: Gauge, epoch: number): Hydrograph {
  const obs = g.observed;
  const base = baseline(obs);
  const lastObs = obs.length ? obs[obs.length - 1].t : -Infinity;
  const pts: [number, number][] = obs.map((r) => [(r.t - epoch) / 60000, Math.max(0, (r.ft - base) * FT)]);
  if (g.forecast.length && obs.length) {
    // NOAA's forecast and the gauge can disagree at the hand-off; shift the forecast to start from the latest reading
    const f0 = g.forecast.find((r) => r.t > lastObs) ?? g.forecast[g.forecast.length - 1];
    const fAtObs = interpolate(g.forecast, lastObs) ?? f0.ft;
    const bias = obs[obs.length - 1].ft - fAtObs;
    const fade = 12 * 3600e3;
    for (const r of g.forecast) {
      if (r.t <= lastObs) continue;
      const k = Math.max(0, 1 - (r.t - lastObs) / fade);
      pts.push([(r.t - epoch) / 60000, Math.max(0, (r.ft + bias * k - base) * FT)]);
    }
  }
  return new Hydrograph(pts);
}

function baseline(obs: Reading[]): number {
  if (!obs.length) return 0;
  const v = obs.map((r) => r.ft).sort((a, b) => a - b);
  // second percentile rather than the minimum, so one bad reading cannot set the floor
  return v[Math.floor(v.length * 0.02)];
}

function interpolate(rs: Reading[], t: number): number | null {
  if (!rs.length || t < rs[0].t || t > rs[rs.length - 1].t) return null;
  for (let i = 1; i < rs.length; i++)
    if (t <= rs[i].t) {
      const a = rs[i - 1];
      const b = rs[i];
      return b.t === a.t ? b.ft : a.ft + ((b.ft - a.ft) * (t - a.t)) / (b.t - a.t);
    }
  return rs[rs.length - 1].ft;
}

/** A curve raised by a fixed amount, for "what if the bayous come up another meter" planning. */
export class OffsetCurve implements StageCurve {
  constructor(
    readonly base: StageCurve,
    readonly add: number,
  ) {}
  stage(t: number): number {
    return Math.max(0, this.base.stage(t) + this.add);
  }
  timeOfStage(s: number, from?: number): number {
    return this.base.timeOfStage(s - this.add, from);
  }
}

export function lonLatToXY(city: City, lon: number, lat: number): [number, number] {
  return [(lon - city.origin[0]) * city.scale[0], (lat - city.origin[1]) * city.scale[1]];
}

export interface Coverage {
  /** For each gauge: where it sits in the model and how much of the channel network it drives. */
  gauges: { id: string; x: number; y: number; snapped: boolean; cells: number }[];
  /** Channel cells driven by a gauge on their own connected stream network. */
  networked: number;
  /** Channel cells with no gauge upstream or downstream, driven by the nearest gauge in a straight line. */
  nearest: number;
}

/**
 * Drive the flood model from gauges. Each gauge is snapped to the nearest mapped channel (within 1 km) and its
 * reading spreads along the connected channel network, so every bayou reach follows the closest gauge on its own
 * stream rather than the closest gauge on a neighboring one. Reaches with no gauge on their network use the nearest
 * gauge in a straight line. Tributaries follow their bayou's gauge at half the rise, unless the gauge is on the
 * tributary itself.
 */
export function driveFromGauges(flood: FloodModel, gauges: Gauge[], epoch: number, offset = 0): Coverage {
  const city = flood.city;
  const { w, h, cell } = city.grid;
  if (!gauges.length) throw new Error('no gauges to drive the flood model');
  const curves: StageCurve[] = gauges.map((g) => {
    const c = gaugeCurve(g, epoch);
    return offset ? new OffsetCurve(c, offset) : c;
  });
  const xy = gauges.map((g) => lonLatToXY(city, g.lon, g.lat));
  const n = w * h;
  const owner = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n).fill(Infinity);
  const ownRank = new Uint8Array(gauges.length);
  const snapped: boolean[] = [];
  // multi-source shortest path over channel cells (8-connected)
  const q: number[] = [];
  xy.forEach(([x, y], gi) => {
    const ci = Math.floor((x - city.grid.x0) / cell);
    const cj = Math.floor((y - city.grid.y0) / cell);
    const R = Math.ceil(1000 / cell);
    let best = -1;
    let bd = Infinity;
    for (let j = Math.max(0, cj - R); j <= Math.min(h - 1, cj + R); j++)
      for (let i = Math.max(0, ci - R); i <= Math.min(w - 1, ci + R); i++) {
        const c = j * w + i;
        if (!city.drain[c]) continue;
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
    snapped.push(best >= 0);
    if (best >= 0 && dist[best] > 0) {
      dist[best] = 0;
      owner[best] = gi;
      ownRank[gi] = city.drain[best];
      q.push(best);
    }
  });
  // Dijkstra along the channels, diagonal steps cost sqrt 2
  const heap = new NumHeap();
  for (const c of q) heap.push(0, c);
  while (heap.size > 0) {
    const d = heap.topKey();
    const c = heap.pop();
    if (d > dist[c]) continue;
    const i = c % w;
    const j = (c - i) / w;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nc = nj * w + ni;
        if (!city.drain[nc]) continue;
        const nd = d + (di && dj ? Math.SQRT2 : 1);
        if (nd < dist[nc]) {
          dist[nc] = nd;
          owner[nc] = owner[c];
          heap.push(nd, nc);
        }
      }
  }
  const cells = new Array(gauges.length).fill(0);
  let networked = 0;
  let nearest = 0;
  const chOf = (s: number) => {
    if (owner[s] >= 0) return owner[s];
    const x = city.grid.x0 + ((s % w) + 0.5) * cell;
    const y = city.grid.y0 + (Math.floor(s / w) + 0.5) * cell;
    let best = 0;
    let bd = Infinity;
    xy.forEach(([gx, gy], gi) => {
      const d = (gx - x) ** 2 + (gy - y) ** 2;
      if (d < bd) {
        bd = d;
        best = gi;
      }
    });
    return best;
  };
  for (let c = 0; c < n; c++) {
    if (!city.drain[c]) continue;
    const g = chOf(c);
    cells[g]++;
    if (owner[c] >= 0) networked++;
    else nearest++;
  }
  flood.setChannels(curves, chOf, (s) => (city.drain[s] === 2 || ownRank[chOf(s)] === 1 ? 1 : TRIBUTARY_RISE));
  return { gauges: gauges.map((g, gi) => ({ id: g.id, x: xy[gi][0], y: xy[gi][1], snapped: snapped[gi], cells: cells[gi] })), networked, nearest };
}

const TRIBUTARY_RISE = 0.5;

/** A planning scenario when no live data is reachable: every bayou rises `rise` meters over `hours`. */
export function scenarioCurve(rise: number, hours: number, start = 0): Hydrograph {
  return new Hydrograph([
    [0, start],
    [hours * 60, start + rise],
  ]);
}

export type FloodCategory = 'none' | 'action' | 'minor' | 'moderate' | 'major';

export function category(g: Gauge, ft: number): FloodCategory {
  const f = g.flood ?? {};
  if (f.major !== undefined && ft >= f.major) return 'major';
  if (f.moderate !== undefined && ft >= f.moderate) return 'moderate';
  if (f.minor !== undefined && ft >= f.minor) return 'minor';
  if (f.action !== undefined && ft >= f.action) return 'action';
  return 'none';
}

export interface GaugeSummary {
  id: string;
  name: string;
  lon: number;
  lat: number;
  latestFt: number;
  latestAt: number;
  /** Change over the last three hours (ft). */
  trendFt: number;
  /** Meters above the base flow the model treats as normal. */
  riseM: number;
  category: FloodCategory;
  forecast: { peakFt: number; peakAt: number; category: FloodCategory } | null;
  flood: Gauge['flood'];
}

export function summarize(g: Gauge): GaugeSummary {
  const last = g.observed[g.observed.length - 1];
  const before = interpolate(g.observed, last.t - 3 * 3600e3) ?? g.observed[0].ft;
  const future = g.forecast.filter((r) => r.t > last.t);
  const peak = future.reduce<Reading | null>((m, r) => (!m || r.ft > m.ft ? r : m), null);
  return {
    id: g.id,
    name: g.name,
    lon: g.lon,
    lat: g.lat,
    latestFt: last.ft,
    latestAt: last.t,
    trendFt: last.ft - before,
    riseM: Math.max(0, (last.ft - baseline(g.observed)) * FT),
    category: category(g, last.ft),
    forecast: peak ? { peakFt: peak.ft, peakAt: peak.t, category: category(g, peak.ft) } : null,
    flood: g.flood,
  };
}

/** The city's bounding box in longitude and latitude. */
export function cityBBox(city: City): BBox {
  const [x0, y0, x1, y1] = city.bounds;
  const [w, s] = city.toLonLat(x0, y0);
  const [e, n] = city.toLonLat(x1, y1);
  return [w, s, e, n];
}
