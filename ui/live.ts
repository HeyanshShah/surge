import type { City } from '../src/city';
import { FloodModel } from '../src/flood';
import { type CallInput, type LiveIncident, LiveCenter, type LiveUnit, type Readiness, type Recommendation, type UnitStatus } from '../src/live/center';
import { type FetchReport, type GaugeSummary, cityBBox, driveFromGauges, fetchGauges, lonLatToXY, scenarioCurve, summarize } from '../src/live/gauges';
import { Router } from '../src/routing';
import type { Triage } from '../src/triage';
import { TYPE_LABEL } from '../src/types';

/**
 * The console's Live mode: the flood model runs on today's river gauges and NOAA forecasts, the dispatcher logs real
 * calls, and the copilot recommends units on the roads as they are now or will be. Served by `surge serve`, the board
 * and the gauge fetch live on the server so every dispatcher shares one picture. Opened as a plain file, it all runs
 * in the browser, and when the page cannot reach the gauge feeds it switches to a planning scenario.
 */

declare global {
  interface Window {
    SURGE_API?: string;
  }
}

/** What the map needs from the console that hosts it. */
export interface Host {
  city: City;
  $: <T extends HTMLElement = HTMLElement>(id: string) => T;
  esc(s: string): string;
  highlight(text: string, tr: Triage): string;
  focusOn(x: number, y: number): void;
  sx(x: number): number;
  sy(y: number): number;
}

type BoardView = { units: LiveUnit[]; incidents: Omit<LiveIncident, 'triage'>[] };
type CallResult = { incident: Omit<LiveIncident, 'triage'>; merged: boolean; triage: Triage };

interface Board {
  call(c: CallInput): Promise<CallResult>;
  recommend(): Promise<Recommendation[]>;
  dispatch(unit: number, incident: number): Promise<void>;
  setUnit(unit: number, status: UnitStatus | 'turned_back'): Promise<void>;
  close(incident: number): Promise<void>;
  view(): Promise<BoardView>;
}

const CAT_COLOR: Record<string, string> = { none: '#4fd18b', action: '#f2d14b', minor: '#ff9f43', moderate: '#ff5a4e', major: '#d65cff' };
const CAT_LABEL: Record<string, string> = { none: 'Normal', action: 'Action stage', minor: 'Minor flooding', moderate: 'Moderate flooding', major: 'Major flooding' };
const HORIZON_H = 48;

export class LiveView {
  readonly flood: FloodModel;
  readonly center: LiveCenter;
  readonly remote: boolean;
  private board: Board;
  epoch = Date.now();
  source: 'loading' | 'live' | 'scenario' = 'loading';
  report: FetchReport | null = null;
  gauges: GaugeSummary[] = [];
  offset = 0;
  scenario = { rise: 3, hours: 12 };
  /** Minutes ahead of now that the map and readiness show. */
  ahead = 0;
  version = 0;
  recs: Recommendation[] = [];
  boardView: BoardView = { units: [], incidents: [] };
  private ready: { key: string; now: Readiness; at: Readiness } | null = null;
  private closed: { key: string; path: Path2D } | null = null;
  private started = false;

  constructor(readonly host: Host) {
    const { city } = host;
    this.flood = new FloodModel(city, [scenarioCurve(0, 1)]);
    this.center = new LiveCenter(city, this.flood, this.epoch, { router: new Router(city, this.flood) });
    this.remote = typeof window.SURGE_API === 'string';
    this.board = this.remote ? remoteBoard(window.SURGE_API!) : localBoard(this.center);
  }

  /** Minutes since the epoch that the view shows. */
  t(): number {
    return this.center.now() + this.ahead;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    await this.sync();
    window.setInterval(() => void this.refresh(), 10 * 60000);
    window.setInterval(() => void this.sync(), this.remote ? 5000 : 30000);
  }

  /** Fetch gauges (through the server when there is one) and re-drive the flood model. */
  async refresh(): Promise<void> {
    const $ = this.host.$;
    $('lv-source').textContent = 'Reading river gauges…';
    try {
      if (this.remote) {
        const st = await api<{ epoch: number }>(window.SURGE_API!, 'GET', '/api/status');
        this.epoch = st.epoch;
        (this.center as { epoch: number }).epoch = st.epoch;
        this.report = await api<FetchReport>(window.SURGE_API!, 'GET', '/api/gauges');
      } else this.report = await fetchGauges(cityBBox(this.host.city), { timeoutMs: 12000 });
    } catch (err) {
      this.report = { gauges: [], fetchedAt: Date.now(), errors: [(err as Error).message] };
    }
    this.gauges = this.report.gauges.filter((g) => g.observed.length).map(summarize);
    this.apply();
  }

  /** Re-drive the model from the latest gauges, the what-if offset, or the planning scenario. */
  apply(): void {
    const gauges = this.report?.gauges ?? [];
    if (gauges.length) {
      driveFromGauges(this.flood, gauges, this.epoch, this.offset);
      this.source = 'live';
    } else {
      this.flood.setChannels([scenarioCurve(this.scenario.rise, this.scenario.hours)], () => 0, (c) => (this.host.city.drain[c] === 2 ? 1 : 0.5));
      this.source = 'scenario';
    }
    this.center.floodChanged();
    this.version++;
    if (this.remote) void api(window.SURGE_API!, 'POST', '/api/scenario', this.source === 'live' ? { offset: this.offset } : { ...this.scenario }).then(() => this.sync());
    else void this.sync();
    this.renderGauges();
    this.hud();
  }

  async sync(): Promise<void> {
    try {
      [this.boardView, this.recs] = await Promise.all([this.board.view(), this.board.recommend()]);
    } catch (err) {
      this.host.$('lv-source').textContent = `Server unreachable: ${(err as Error).message}`;
      return;
    }
    this.renderDispatch();
  }

  // ---------------------------------------------------------------- numbers for the header and KPIs

  readiness(): { now: Readiness; at: Readiness } {
    const key = `${this.version}|${Math.round(this.t() / 10)}|${Math.round(this.center.now() / 10)}`;
    if (this.ready?.key !== key) {
      const now = this.center.now();
      this.ready = { key, now: this.center.readiness(now), at: this.center.readiness(this.t(), this.t()) };
    }
    return this.ready;
  }

  clock(t = this.t()): { date: string; time: string } {
    const d = new Date(this.epoch + t * 60000);
    return {
      date: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
    };
  }

  maxRise(t = this.t()): number {
    return Math.max(0, ...this.flood.curves.map((c) => c.stage(t)));
  }

  hud(): void {
    const { $ } = this.host;
    const c = this.clock();
    $('clock').textContent = c.time;
    $('date').textContent = this.ahead > 0 ? `${c.date} · +${fmtH(this.ahead)}` : `${c.date} · now`;
    const st = this.maxRise();
    $('stage').textContent = `+${st.toFixed(1)}`;
    $('stagefill').style.width = `${Math.min(100, (st / 6) * 100)}%`;
    $('lv-ahead').textContent = this.ahead > 0 ? `+${fmtH(this.ahead)} · ${c.time}` : 'Now';
    const r = this.readiness();
    const k = (id: string, at: number, now: number, unit: string, dp = 0) => {
      const el = $(id);
      el.querySelector('.ks')!.textContent = at.toFixed(dp) + unit;
      el.querySelector('.kc')!.textContent = this.ahead > 0 ? `now ${now.toFixed(dp)}${unit}` : '';
      const d = el.querySelector('.kdelta')!;
      d.textContent = this.ahead > 0 && at - now > 0.05 ? `+${(at - now).toFixed(dp)}${unit} by ${c.time}` : '';
      d.className = `kdelta ${at - now > 0.05 ? 'bad' : ''}`;
    };
    k('lk-car', r.at.closedKm.car, r.now.closedKm.car, ' km');
    k('lk-hw', r.at.closedKm.highwater, r.now.closedKm.highwater, ' km');
    k('lk-addr', r.at.addresses.stall, r.now.addresses.stall, '');
    k('lk-sta', r.at.stationsCutOff.length, r.now.stationsCutOff.length, '');
    $('lk-addr').querySelector('.klabel')!.textContent = `Addresses in 0.3 m+ water (of ${r.at.addresses.total.toLocaleString()})`;
    const src = $('lv-source');
    if (this.source === 'live') {
      const fc = this.gauges.filter((g) => g.forecast).length;
      src.textContent = `${this.gauges.length} live gauges · ${fc} NOAA forecast${fc === 1 ? '' : 's'} · updated ${new Date(this.report!.fetchedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
      src.className = 'chip go';
    } else if (this.source === 'scenario') {
      src.textContent = `Planning scenario: bayous +${this.scenario.rise} m over ${this.scenario.hours} h`;
      src.className = 'chip hot';
    }
    $('lv-whatif-wrap').hidden = this.source !== 'live';
    $('lv-scen-wrap').hidden = this.source !== 'scenario';
  }

  // ---------------------------------------------------------------- map

  depthCell(c: number): number {
    return this.flood.depthCell(c, this.t());
  }

  floodKey(): string {
    return `live|${this.version}|${Math.round(this.t() / 5)}`;
  }

  draw(ctx: CanvasRenderingContext2D, view: { s: number }, pulse: number): void {
    const { city, sx, sy } = this.host;
    // roads closed to cars at the time shown
    const key = this.floodKey();
    if (this.closed?.key !== key) {
      const path = new Path2D();
      const t = this.t();
      for (let e = 0; e < city.m; e++) {
        if (this.flood.passable(e, 'car', t)) continue;
        const p = city.edgePoints(e);
        path.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i + 1]);
      }
      this.closed = { key, path };
    }
    ctx.save();
    const dpr = ctx.getTransform().a;
    ctx.setTransform(dpr * view.s, 0, 0, -dpr * view.s, dpr * sx(0), dpr * sy(0));
    ctx.strokeStyle = '#ff5a4ebb';
    ctx.lineWidth = 1.6 / view.s;
    ctx.lineCap = 'round';
    ctx.stroke(this.closed.path);
    ctx.restore();

    // where water reaches chest height first: stage boats nearby
    const r = this.readiness();
    if (this.ahead > 0)
      for (const s of r.at.firstStreets) {
        ctx.strokeStyle = '#4fd1c5';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.arc(sx(s.x), sy(s.y), 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

    // recommendations
    for (const rec of this.recs) {
      if (!rec.route) continue;
      ctx.strokeStyle = '#ffb547';
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      for (let i = 0; i < rec.route.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, sx(rec.route[i]), sy(rec.route[i + 1]));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // units
    for (const u of this.boardView.units) {
      if (u.status === 'available' && !this.recs.some((x) => x.unit === u.id)) continue;
      const x = sx(city.nx[u.node]);
      const y = sy(city.ny[u.node]);
      ctx.fillStyle = { engine: '#ffb547', medic: '#f4f7fd', rescue: '#4fd1c5', police: '#7aa2ff' }[u.kind];
      ctx.globalAlpha = u.status === 'available' ? 0.7 : 1;
      if (u.kind === 'rescue') {
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 5, y);
        ctx.fill();
      } else ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
      ctx.globalAlpha = 1;
    }

    // incidents
    const ACU = ['#ff5a4e', '#ff5a4e', '#ff9f43', '#f2d14b', '#8a96ad', '#8a96ad'];
    for (const c of this.boardView.incidents) {
      if (c.status === 'closed' || !Number.isFinite(c.x)) continue;
      const x = sx(c.x);
      const y = sy(c.y);
      const col = ACU[c.acuity] ?? ACU[5];
      const rr = 4 + Math.min(4, c.people * 0.6);
      if (c.status === 'waiting') {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.25 + 0.5 * pulse;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, rr + 3 + 3 * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fill();
    }

    // gauges
    for (const g of this.gauges) {
      const [gx, gy] = lonLatToXY(city, g.lon, g.lat);
      const x = sx(gx);
      const y = sy(gy);
      ctx.fillStyle = '#070c18';
      ctx.strokeStyle = CAT_COLOR[g.forecast && this.ahead > 0 ? worst(g.category, g.forecast.category) : g.category];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(x - 5, y - 5, 10, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  }

  /** A tap on the map: the nearest gauge or incident. */
  tap(px: number, py: number): boolean {
    const { city, sx, sy } = this.host;
    let best: { d: number; f: () => void } | null = null;
    for (const g of this.gauges) {
      const [x, y] = lonLatToXY(city, g.lon, g.lat);
      const d = (sx(x) - px) ** 2 + (sy(y) - py) ** 2;
      if (d < 18 * 18 && (!best || d < best.d)) best = { d, f: () => this.showGauge(g.id) };
    }
    for (const c of this.boardView.incidents) {
      if (c.status === 'closed' || !Number.isFinite(c.x)) continue;
      const d = (sx(c.x) - px) ** 2 + (sy(c.y) - py) ** 2;
      if (d < 18 * 18 && (!best || d < best.d)) best = { d, f: () => this.showTab('dispatch', c.id) };
    }
    best?.f();
    return !!best;
  }

  showTab: (k: 'gauges' | 'dispatch' | 'take', focus?: number) => void = () => {};

  showGauge(id: string): void {
    this.showTab('gauges');
    const el = document.querySelector(`[data-gauge="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
    el?.classList.add('flash');
    window.setTimeout(() => el?.classList.remove('flash'), 1200);
  }

  // ---------------------------------------------------------------- side panes

  renderGauges(): void {
    const { $, esc } = this.host;
    const errs = this.report?.errors ?? [];
    if (this.source === 'scenario') {
      $('lv-gauges').innerHTML = `<div class="card"><div class="big">No live gauge feed here</div>
        <p class="hint">This page could not reach the USGS and NOAA gauge services${errs.length ? ` (${esc(errs[0])})` : ''}, which happens inside sandboxed previews. The model is running the planning scenario set at the bottom instead. Run <code>surge serve</code> or open the file directly to use live gauges.</p></div>`;
      return;
    }
    const rows = [...this.gauges].sort((a, b) => rank(b.forecast?.category ?? b.category) - rank(a.forecast?.category ?? a.category) || b.riseM - a.riseM);
    $('lv-gauges').innerHTML =
      rows
        .map((g) => {
          const trend = g.trendFt > 0.05 ? `▲ ${g.trendFt.toFixed(1)} ft / 3 h` : g.trendFt < -0.05 ? `▼ ${(-g.trendFt).toFixed(1)} ft / 3 h` : 'steady';
          const fc = g.forecast
            ? `<div class="hint">NOAA forecast: crest ${g.forecast.peakFt.toFixed(1)} ft ${new Date(g.forecast.peakAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${g.forecast.category !== 'none' ? ` · <b style="color:${CAT_COLOR[g.forecast.category]}">${CAT_LABEL[g.forecast.category]}</b>` : ''}</div>`
            : '<div class="hint">No NOAA forecast at this gauge; the model holds the latest reading.</div>';
          const fl = g.flood?.minor !== undefined ? ` · floods at ${g.flood.minor} ft` : '';
          return `<li class="call gauge-row" data-gauge="${esc(g.id)}" style="border-left-color:${CAT_COLOR[g.category]}">
            <div class="chead"><span class="ctype">${esc(g.name)}</span></div>
            <div class="gline"><b>${g.latestFt.toFixed(1)} ft</b><span>${trend}</span><span class="hint">${new Date(g.latestAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}${fl}</span></div>
            ${fc}</li>`;
        })
        .join('') || '<li class="hint">No gauges.</li>';
  }

  renderDispatch(focus?: number): void {
    const { $, esc } = this.host;
    const { units, incidents } = this.boardView;
    const open = incidents.filter((c) => c.status !== 'closed').sort((a, b) => a.acuity - b.acuity || a.opened - b.opened);
    const free = units.filter((u) => u.status === 'available').length;
    const recs = this.recs
      .map(
        (r) => `<li class="rec"><div><b>${esc(r.unitName)}</b> → ${esc(r.label)}</div>
        <div class="hint">${Math.max(1, Math.round(r.minutes))} min on open roads · ${r.gain >= 0.01 ? `${r.gain.toFixed(2)} expected lives saved by going now` : 'low risk, closest suitable unit'}</div>
        <button class="primary small" data-go="${r.unit},${r.incident}">Dispatch</button></li>`,
      )
      .join('');
    const inc = open
      .map((c) => {
        const u = c.unit >= 0 ? units[c.unit] : null;
        const btns = u
          ? `<div class="btnrow">${u.status === 'en_route' ? `<button class="ghost small" data-unit="${u.id}" data-st="on_scene">On scene</button><button class="ghost small" data-unit="${u.id}" data-st="turned_back">Turned back</button>` : ''}<button class="ghost small" data-unit="${u.id}" data-st="available">Clear</button></div>`
          : `<div class="btnrow"><button class="ghost small" data-close="${c.id}">Close</button></div>`;
        return `<li class="call acu${Math.min(3, c.acuity)} ${c.id === focus ? 'flash' : ''}" data-inc="${c.id}">
          <div class="chead"><span class="ctime">${this.clock(c.opened).time}</span><span class="ctype">${TYPE_LABEL[c.type]}</span><span class="ctime">#${c.id}</span></div>
          <div class="ctext">${esc(c.addressText ?? 'Location from phone')} · ${c.people} ${c.people === 1 ? 'person' : 'people'}${c.calls.length > 1 ? ` · ${c.calls.length} calls` : ''}</div>
          <div class="cfoot"><span class="chip ${c.acuity <= 1 ? 'hot' : ''}">P${c.acuity}</span>${u ? `<span class="chip go">${esc(u.name)} · ${u.status.replace('_', ' ')}</span>` : '<span class="chip">waiting</span>'}${c.blocked.length ? `<span class="chip hot">turned back: ${c.blocked.join(', ')}</span>` : ''}</div>
          ${btns}</li>`;
      })
      .join('');
    $('lv-dispatch').innerHTML = `
      <div class="blabel">Copilot recommends</div>
      <ol class="feed">${recs || '<li class="hint">Nothing to send. Log a call under “Take a call”.</li>'}</ol>
      <div class="blabel">Open incidents (${open.length})</div>
      <ol class="feed">${inc || '<li class="hint">No open incidents.</li>'}</ol>
      <div class="hint">${free} of ${units.length} units available.</div>`;
  }

  async take(text: string, phone: string): Promise<string> {
    const { esc, highlight } = this.host;
    const r = await this.board.call({ text, phone: phone || undefined });
    await this.sync();
    const rec = this.recs.find((x) => x.incident === r.incident.id);
    const tr = r.triage;
    const a = r.incident;
    let water = '';
    if (Number.isFinite(a.x)) {
      const now = this.flood.depthAt(a.x, a.y, this.center.now());
      const chest = this.flood.timeToDepth(a.x, a.y, 1.2, this.center.now());
      water = `<dt>Water</dt><dd>${now.toFixed(1)} m now; ${Number.isFinite(chest) ? (chest <= this.center.now() ? 'already chest-deep' : `chest-deep by ${this.clock(chest).time} ${this.clock(chest).date}`) : `stays below chest height${this.source === 'live' ? ' on the current forecast' : ''}`}</dd>`;
      this.host.focusOn(a.x, a.y);
    }
    return `<div class="card">
      <div class="big">${TYPE_LABEL[tr.type]}${r.merged ? ` <span class="chip merge">merged into #${a.id}</span>` : ` <span class="chip">#${a.id}</span>`}</div>
      <dl class="kv">
        <dt>Priority</dt><dd>P${a.acuity} · ${(tr.confidence * 100).toFixed(0)}% confident</dd>
        <dt>Where</dt><dd>${a.addressText ? esc(a.addressText) : 'No address heard; needs the phone location'}</dd>
        <dt>Who</dt><dd>${a.people} ${a.people === 1 ? 'person' : 'people'}${Object.entries(a.vuln).filter(([, v]) => v).map(([k]) => `, ${k}`).join('')}</dd>
        ${water}
        <dt>Send</dt><dd>${rec ? `${esc(rec.unitName)}, ${Math.max(1, Math.round(rec.minutes))} min <button class="primary small" data-go="${rec.unit},${rec.incident}">Dispatch</button>` : a.status === 'closed' ? 'No unit needed' : 'Queued: no free unit can reach it right now'}</dd>
      </dl>
      <div class="ctext">${highlight(text, tr)}</div></div>`;
  }

  async act(el: HTMLElement): Promise<void> {
    try {
      if (el.dataset.go) {
        const [u, i] = el.dataset.go.split(',').map(Number);
        await this.board.dispatch(u, i);
      } else if (el.dataset.unit) await this.board.setUnit(Number(el.dataset.unit), el.dataset.st as UnitStatus);
      else if (el.dataset.close) await this.board.close(Number(el.dataset.close));
      else return;
    } catch (err) {
      alert((err as Error).message);
    }
    await this.sync();
  }
}

function localBoard(c: LiveCenter): Board {
  const view = (): BoardView => JSON.parse(JSON.stringify(c.snapshot()));
  return {
    async call(input) {
      const r = c.call(input);
      const { triage: _t, ...incident } = r.incident;
      return { incident, merged: r.merged, triage: r.triage };
    },
    async recommend() {
      return c.recommend();
    },
    async dispatch(u, i) {
      c.dispatch(u, i);
    },
    async setUnit(u, s) {
      c.setUnit(u, s);
    },
    async close(i) {
      c.close(i);
    },
    async view() {
      return view();
    },
  };
}

function remoteBoard(base: string): Board {
  return {
    call: (input) => api(base, 'POST', '/api/calls', input),
    recommend: () => api(base, 'GET', '/api/recommendations'),
    dispatch: (unit, incident) => api(base, 'POST', '/api/dispatch', { unit, incident }).then(() => undefined),
    setUnit: (u, status) => api(base, 'POST', `/api/units/${u}`, { status }).then(() => undefined),
    close: (i) => api(base, 'POST', `/api/incidents/${i}/close`, {}).then(() => undefined),
    view: () => api(base, 'GET', '/api/board'),
  };
}

async function api<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

function rank(c: string): number {
  return ['none', 'action', 'minor', 'moderate', 'major'].indexOf(c);
}

function worst(a: string, b: string): string {
  return rank(a) >= rank(b) ? a : b;
}

export function fmtH(min: number): string {
  return min < 60 ? `${Math.round(min)} min` : `${Math.round(min / 60)} h`;
}

export { HORIZON_H };
