import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { join } from 'node:path';
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
 *   GET  /api/audit             every change to the board, who made it, and whether dispatches followed the copilot
 *   GET  /healthz               no auth; 503 when the gauge data is stale
 *
 * With --data, every change is appended to <data>/events.jsonl before it is acknowledged and replayed on restart,
 * so a crash or redeploy loses nothing. With --tokens, every request needs a dispatcher's token, and the audit log
 * records which dispatcher did what.
 */

export interface ServeOptions {
  port: number;
  html?: string;
  /** Serve a saved gauge snapshot (from `surge live --save`) instead of fetching, e.g. to rehearse a past flood offline. */
  gauges?: string;
  refreshMinutes?: number;
  /** Interface to listen on. Defaults to 127.0.0.1; anything else requires tokens. */
  host?: string;
  /** Folder for the event journal; without it the board lives in memory only. */
  data?: string;
  /** Dispatcher tokens, token -> name. */
  tokens?: Map<string, string>;
  log?: (s: string) => void;
}

/** One change to the board, as journaled and replayed. */
export interface BoardEvent {
  at: number;
  by: string;
  path: string;
  body: Record<string, unknown>;
  /** Dispatches: whether the dispatcher took the copilot's recommendation, and what it was. */
  followed?: boolean;
  recommended?: string | null;
}

/** Who is making a request, and whether it is a replay of the journal. */
export interface RequestContext {
  by: string;
  replay?: boolean;
}

/** Gauge data older than this is stale: the console warns and /healthz fails. */
export const STALE_MINUTES = 30;

export interface LiveState {
  center: LiveCenter;
  source: 'live' | 'scenario' | 'none';
  report: FetchReport | null;
  coverage: Coverage | null;
  offset: number;
  scenario: { rise: number; hours: number } | null;
  events: BoardEvent[];
  /** Pins the board's clock while replaying the journal. */
  pinned: number | null;
  journal: string | null;
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
    ...freshness(state),
  };
}

export function makeState(city: City, epoch = Date.now(), journal: string | null = null): LiveState {
  // start dry: until the first fetch lands nothing is assumed about the water
  const flood = new FloodModel(city, [scenarioCurve(0, 1)]);
  const state: LiveState = { center: null as unknown as LiveCenter, source: 'none', report: null, coverage: null, offset: 0, scenario: null, events: [], pinned: null, journal };
  state.center = new LiveCenter(city, flood, epoch, { clock: () => state.pinned ?? Date.now() });
  return state;
}

/**
 * Open a board backed by a journal: the first line holds the epoch, every later line one change, replayed in order
 * at the time it was made. Returns a fresh board when the journal does not exist yet.
 */
export async function openJournal(city: City, dir: string): Promise<LiveState> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'events.jsonl');
  if (!existsSync(path)) {
    const state = makeState(city, Date.now(), path);
    appendFileSync(path, `${JSON.stringify({ epoch: state.center.epoch, city: city.name })}\n`);
    return state;
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const head = JSON.parse(lines[0]) as { epoch: number; city: string };
  if (head.city !== city.name) throw new Error(`${path} belongs to ${head.city}, not ${city.name}`);
  const state = makeState(city, head.epoch, null);
  for (const line of lines.slice(1)) {
    let ev: BoardEvent;
    try {
      ev = JSON.parse(line) as BoardEvent;
    } catch {
      continue; // a line cut off by a crash mid-write
    }
    state.pinned = ev.at;
    try {
      await handle(state, 'POST', ev.path, new URLSearchParams(), ev.body, { by: ev.by, replay: true });
    } catch {
      // it failed when it was made too; journaled only for the record
    }
    state.events.push(ev);
  }
  state.pinned = null;
  state.journal = path;
  return state;
}

function record(state: LiveState, ev: BoardEvent): void {
  // written before the change is acknowledged, so an acknowledged change survives a crash
  if (state.journal) appendFileSync(state.journal, `${JSON.stringify(ev)}\n`);
  state.events.push(ev);
}

export function freshness(state: LiveState): { stale: boolean; ageMinutes: number | null } {
  const at = state.report?.fetchedAt;
  if (state.source !== 'live' || !at) return { stale: state.source === 'none', ageMinutes: null };
  // a fetch can succeed while the gauges themselves stopped reporting
  const newest = Math.max(...state.report!.gauges.map((g) => g.observed[g.observed.length - 1]?.t ?? 0));
  const age = (Date.now() - Math.min(at, newest + 90 * 60000)) / 60000;
  return { stale: age > STALE_MINUTES, ageMinutes: Math.round(age) };
}

/** Route one API request against the live state. Exported for tests; returns [status, body]. */
export async function handle(state: LiveState, method: string, path: string, query: URLSearchParams, body: unknown, ctx: RequestContext = { by: 'local' }): Promise<[number, unknown]> {
  const out = await route(state, method, path, query, body, ctx);
  if (method === 'POST' && !ctx.replay) record(state, { at: Date.now(), by: ctx.by, path, body: (body ?? {}) as Record<string, unknown>, ...out[2] });
  return [out[0], out[1]];
}

async function route(state: LiveState, method: string, path: string, query: URLSearchParams, body: unknown, ctx: RequestContext): Promise<[number, unknown, Partial<BoardEvent>?]> {
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
  if (method === 'GET' && path === '/api/audit') {
    const d = state.events.filter((e) => e.path === '/api/dispatch' && e.followed !== undefined);
    return [
      200,
      {
        dispatches: d.length,
        followedCopilot: d.filter((e) => e.followed).length,
        overrides: d.filter((e) => !e.followed).map((e) => ({ at: e.at, by: e.by, ...e.body, recommended: e.recommended })),
        events: state.events.slice(-500),
      },
    ];
  }
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
    const unit = num(b.unit, 'unit');
    const incident = num(b.incident, 'incident');
    // for the audit: did the dispatcher take the copilot's pick? (skipped on replay, where it is already recorded)
    const rec = ctx.replay ? null : c.recommend(false).find((r) => r.incident === incident);
    c.dispatch(unit, incident);
    return [200, c.snapshot(), ctx.replay ? {} : { followed: rec?.unit === unit, recommended: rec ? rec.unitName : null }];
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
  const host = opts.host ?? '127.0.0.1';
  const tokens = opts.tokens;
  if (!tokens?.size && !/^(127\.|localhost$|::1$)/.test(host)) throw new Error(`refusing to serve on ${host} without --tokens: anyone on the network could dispatch units`);
  const state = opts.data ? await openJournal(city, opts.data) : makeState(city);
  if (opts.data) log(`board: ${state.events.length} changes replayed from ${state.journal}`);
  const html = opts.html ? readFileSync(opts.html, 'utf8').replace('<head>', '<head>\n<script>window.SURGE_API = "";</script>') : null;
  const who = (req: IncomingMessage, url: URL): string | null => {
    if (!tokens?.size) return 'local';
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)surge_token=([^;]+)/)?.[1];
    const t = bearer ?? (cookie && decodeURIComponent(cookie)) ?? url.searchParams.get('token') ?? '';
    return tokens.get(t) ?? null;
  };
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
    const send = (code: number, body: unknown, type = 'application/json', extra: Record<string, string> = {}) => {
      // open CORS only on an unauthenticated local server, so a page elsewhere cannot drive a real board
      const cors: Record<string, string> = tokens?.size ? {} : { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors, ...extra });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (req.method === 'OPTIONS') return send(204, '', 'text/plain');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const f = freshness(state);
      return send(f.stale ? 503 : 200, { ok: !f.stale, source: state.source, gaugeAgeMinutes: f.ageMinutes, events: state.events.length });
    }
    const by = who(req, url);
    if (!by) {
      if (url.pathname.startsWith('/api/')) return send(401, { error: 'unauthorized: send your dispatcher token' });
      return send(401, '<!doctype html><meta charset="utf-8"><title>Surge</title><body style="font:16px system-ui;background:#0a1020;color:#e7ecf6;padding:40px"><h1>Surge</h1><p>Open this console with the link your supervisor gave you, ending in <code>?token=…</code>.</p>', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (url.searchParams.has('token')) {
        // trade the link's token for a cookie and drop it from the address bar
        const cookie = `surge_token=${encodeURIComponent(url.searchParams.get('token')!)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${14 * 86400}`;
        return send(302, '', 'text/plain', { location: '/', 'set-cookie': cookie });
      }
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
      const [code, out] = await handle(state, req.method ?? 'GET', url.pathname, url.searchParams, body, { by });
      send(code, out);
    } catch (err) {
      const code = err instanceof HttpError ? err.code : 409;
      send(code, { error: (err as Error).message });
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  log(`Surge live console for ${city.name}: http://${host}:${opts.port}${tokens?.size ? ` (${tokens.size} dispatcher tokens)` : ''}`);
}
