import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { City } from '../city';
import { FloodModel } from '../flood';
import { LiveCenter } from './center';
import { type Coverage, type FetchReport, type Gauge, cityBBox, driveFromGauges, fetchGauges, scenarioCurve, summarize } from './gauges';

/**
 * `surge serve`: the live console and a small JSON API for one dispatch center.
 * Gauges are fetched server-side (no browser CORS limits) and refreshed every few minutes; calls can be posted by
 * a call-taker's screen, a speech-to-text pipeline or an existing CAD system.
 *
 *   GET  /                      the console
 *   GET  /api/status            data source, gauges with NOAA forecasts, model coverage
 *   GET  /api/gauges            the raw gauge readings and forecasts the model runs on
 *   GET  /api/readiness?hours=6 roads closed, addresses under water, stations cut off, streets to stage boats on
 *   GET  /api/board             units and incidents
 *   GET  /api/recommendations   the copilot's assignments right now
 *   POST /api/calls             {text, phone?, lat?, lon?, accuracy?}
 *   POST /api/dispatch          {unit, incident}
 *   POST /api/units/:id         {status: available | en_route | on_scene | out_of_service | turned_back}
 *   POST /api/incidents/:id/close
 *   POST /api/scenario          {offset} raise every live gauge by this many meters, or {rise, hours} with no live data, or {} to reset
 */

export interface ServeOptions {
  port: number;
  html?: string;
  /** Serve a saved gauge snapshot (from `surge live --save`) instead of fetching, e.g. to rehearse a past flood offline. */
  gauges?: string;
  refreshMinutes?: number;
  log?: (s: string) => void;
}

export interface LiveState {
  center: LiveCenter;
  source: 'live' | 'scenario' | 'none';
  report: FetchReport | null;
  coverage: Coverage | null;
  offset: number;
  scenario: { rise: number; hours: number } | null;
}

export async function refresh(state: LiveState, fetcher = fetchGauges): Promise<void> {
  const { center } = state;
  const report = await fetcher(cityBBox(center.city));
  state.report = report;
  applyGauges(state, report.gauges);
}

export function applyGauges(state: LiveState, gauges: Gauge[]): void {
  const { center } = state;
  if (state.scenario || !gauges.length) {
    const s = state.scenario;
    center.flood.setChannels([scenarioCurve(s?.rise ?? 0, s?.hours ?? 1)], () => 0, (c) => (center.city.drain[c] === 2 ? 1 : 0.5));
    state.source = s ? 'scenario' : 'none';
    state.coverage = null;
  } else {
    state.coverage = driveFromGauges(center.flood, gauges, center.epoch, state.offset);
    state.source = 'live';
  }
  center.floodChanged();
}

export function status(state: LiveState) {
  const r = state.report;
  return {
    city: state.center.city.name,
    bbox: cityBBox(state.center.city),
    epoch: state.center.epoch,
    now: state.center.now(),
    source: state.source,
    offset: state.offset,
    scenario: state.scenario,
    fetchedAt: r?.fetchedAt ?? null,
    errors: r?.errors ?? [],
    gauges: (r?.gauges ?? []).map(summarize),
    coverage: state.coverage,
  };
}

export function makeState(city: City, epoch = Date.now()): LiveState {
  // start dry: until the first fetch lands nothing is assumed about the water
  const flood = new FloodModel(city, [scenarioCurve(0, 1)]);
  return { center: new LiveCenter(city, flood, epoch), source: 'none', report: null, coverage: null, offset: 0, scenario: null };
}

/** Route one API request against the live state. Exported for tests; returns [status, body]. */
export async function handle(state: LiveState, method: string, path: string, query: URLSearchParams, body: unknown): Promise<[number, unknown]> {
  const c = state.center;
  const b = (body ?? {}) as Record<string, unknown>;
  const num = (v: unknown, name: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
    return n;
  };
  if (method === 'GET' && path === '/api/status') return [200, status(state)];
  if (method === 'GET' && path === '/api/gauges') return [200, state.report ?? { gauges: [], fetchedAt: null, errors: ['not fetched yet'] }];
  if (method === 'GET' && path === '/api/readiness') {
    const hours = query.has('hours') ? num(query.get('hours'), 'hours') : 6;
    const t = c.now() + hours * 60;
    return [200, { now: c.readiness(c.now(), t), ahead: c.readiness(t) }];
  }
  if (method === 'GET' && path === '/api/board') return [200, c.snapshot()];
  if (method === 'GET' && path === '/api/recommendations') return [200, c.recommend()];
  if (method === 'POST' && path === '/api/calls') {
    if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'text is required');
    const r = c.call({
      text: b.text,
      phone: typeof b.phone === 'string' ? b.phone : undefined,
      lat: b.lat === undefined ? undefined : num(b.lat, 'lat'),
      lon: b.lon === undefined ? undefined : num(b.lon, 'lon'),
      accuracy: b.accuracy === undefined ? undefined : num(b.accuracy, 'accuracy'),
    });
    const { triage, ...incident } = r.incident;
    return [r.merged ? 200 : 201, { merged: r.merged, incident, triage: { ...r.triage, address: r.triage.address } }];
  }
  if (method === 'POST' && path === '/api/dispatch') {
    c.dispatch(num(b.unit, 'unit'), num(b.incident, 'incident'));
    return [200, c.snapshot()];
  }
  let m = path.match(/^\/api\/units\/(\d+)$/);
  if (method === 'POST' && m) {
    const st = String(b.status);
    if (!['available', 'en_route', 'on_scene', 'out_of_service', 'turned_back'].includes(st)) throw new HttpError(400, 'unknown status');
    c.setUnit(Number(m[1]), st as never);
    return [200, c.snapshot()];
  }
  m = path.match(/^\/api\/incidents\/(\d+)\/close$/);
  if (method === 'POST' && m) {
    c.close(Number(m[1]));
    return [200, c.snapshot()];
  }
  if (method === 'POST' && path === '/api/scenario') {
    state.offset = b.offset === undefined ? 0 : num(b.offset, 'offset');
    state.scenario = b.rise === undefined ? null : { rise: num(b.rise, 'rise'), hours: b.hours === undefined ? 12 : num(b.hours, 'hours') };
    applyGauges(state, state.report?.gauges ?? []);
    return [200, status(state)];
  }
  throw new HttpError(404, 'not found');
}

class HttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export async function serve(city: City, opts: ServeOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const state = makeState(city);
  const html = opts.html ? readFileSync(opts.html, 'utf8').replace('<head>', '<head>\n<script>window.SURGE_API = "";</script>') : null;
  const tick = async () => {
    try {
      await refresh(state);
      const r = state.report!;
      log(`${new Date().toISOString()} gauges: ${r.gauges.length} live (${r.gauges.filter((g) => g.forecast.length).length} with NOAA forecasts)${r.errors.length ? `; ${r.errors.join('; ')}` : ''}`);
    } catch (err) {
      log(`gauge refresh failed: ${(err as Error).message}`);
    }
  };
  if (opts.gauges) {
    state.report = JSON.parse(readFileSync(opts.gauges, 'utf8')) as FetchReport;
    applyGauges(state, state.report.gauges);
    log(`gauges: ${state.report.gauges.length} from snapshot ${opts.gauges} (fetched ${new Date(state.report.fetchedAt).toISOString()})`);
  } else {
    await tick();
    setInterval(tick, (opts.refreshMinutes ?? 10) * 60000).unref();
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (req.method === 'OPTIONS') return send(204, '', 'text/plain');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return html ? send(200, html, 'text/html; charset=utf-8') : send(404, { error: 'run `npm run build` to create the console' });
    }
    try {
      let body: unknown = null;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const ch of req) {
          size += (ch as Buffer).length;
          if (size > 64 * 1024) throw new HttpError(413, 'body too large');
          chunks.push(ch as Buffer);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          throw new HttpError(400, 'body must be JSON');
        }
      }
      const [code, out] = await handle(state, req.method ?? 'GET', url.pathname, url.searchParams, body);
      send(code, out);
    } catch (err) {
      const code = err instanceof HttpError ? err.code : 409;
      send(code, { error: (err as Error).message });
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  log(`Surge live console for ${city.name}: http://localhost:${opts.port}`);
}
