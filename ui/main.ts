import { City, type CityData } from '../src/city';
import { FloodModel } from '../src/flood';
import type { PolicyReplay, Replay, ReplayCad, ReplayLeg } from '../src/replay';
import { Router, along } from '../src/routing';
import { type Triage, Triager } from '../src/triage';
import { CAN_SERVE, TYPE_LABEL, type IncidentType } from '../src/types';

declare const __CITY__: string;
declare const __REPLAY__: Replay;
declare const __BENCH__: Bench | null;
declare const __WORKER_SRC__: string;
// referenced once each so the bundler inlines the big blobs a single time
const CITY_SRC: string = __CITY__;

interface Bench {
  seeds: number;
  units: number;
  rows: { policy: string; deaths: number; ci: number; reached: number; p1Median: number; p1P90: number; p1Unreached: number; turnedBack: number; wasted: number; repeat: number }[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const C = {
  bg: '#070c18',
  roads: ['#56688f', '#43537a', '#3a496c', '#323f5e', '#2a3652', '#1d2842', '#1d2842', '#1a2338'],
  water: '#2a63c4',
  a1: '#ff5a4e',
  a2: '#ff9f43',
  a3: '#f2d14b',
  a4: '#8a96ad',
  ok: '#4fd18b',
  amber: '#ffb547',
  steel: '#8a96ad',
  unit: { engine: '#ffb547', medic: '#f4f7fd', rescue: '#4fd1c5', police: '#7aa2ff' } as Record<string, string>,
};
const ACU = [C.a1, C.a1, C.a2, C.a3, C.a4, C.a4];
const EXAMPLES: [string, string][] = [
  ['Attic', "we're in the attic with my mom she's 79, water is almost to the ceiling, 5607 pardee street, please hurry"],
  ['Car', 'my car stalled in high water on the feeder road and water is coming in the doors, 2401 south braeswood'],
  ['Cardiac', "my husband collapsed and he isn't breathing, i'm doing cpr, we're at 4810 north braeswood"],
  ['Not urgent', "hi i just want to know where the nearest shelter is, we are ok, 1919 beall st"],
];

let city: City;
let flood: FloodModel;
let router: Router;
let triager: Triager;
let replay: Replay = __REPLAY__;
let pol: 'surge' | 'cad' = 'surge';
let T = 0;
let playing = false;
let speed = 5;
let selected: number | null = null;
let take: { x: number; y: number; route: number[] | null; label: string } | null = null;

// ------------------------------------------------------------------ boot

window.setTimeout(boot, 30);

function boot(): void {
  city = new City(JSON.parse(CITY_SRC) as CityData);
  flood = new FloodModel(city);
  router = new Router(city, flood);
  triager = new Triager(city);
  buildPaths();
  fit();
  wire();
  indexReplay();
  renderAbout();
  $('loading').hidden = true;
  setTime(150);
  requestAnimationFrame(frame);
}

function P(): PolicyReplay {
  return replay.policies.find((p) => p.key === pol)!;
}
function Pk(k: 'surge' | 'cad'): PolicyReplay {
  return replay.policies.find((p) => p.key === k)!;
}

// answered calls per policy, sorted by answer time, for the feed
let answered: Record<string, [number, number][]> = {};
function indexReplay(): void {
  answered = {};
  for (const p of replay.policies) {
    const a: [number, number][] = [];
    p.calls.forEach(([t, cad], i) => {
      if (t >= 0 && cad >= 0) a.push([t, i]);
    });
    a.sort((x, y) => x[0] - y[0]);
    answered[p.key] = a;
  }
  ($('scrub') as HTMLInputElement).max = String(replay.minutes);
  feedKey = '';
  drawTimelineBase();
}

// ------------------------------------------------------------------ map view

const canvas = $<HTMLCanvasElement>('map');
const ctx = canvas.getContext('2d')!;
const view = { cx: 0, cy: 0, s: 0.05 };
let W = 0;
let H = 0;
let dpr = 1;

function resize(): void {
  const r = canvas.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = r.width;
  H = r.height;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  baseKey = '';
}

function fit(): void {
  resize();
  const [x0, y0, x1, y1] = city.bounds;
  view.cx = (x0 + x1) / 2;
  view.cy = (y0 + y1) / 2;
  view.s = Math.min(W / (x1 - x0), H / (y1 - y0)) * 1.02;
  baseKey = '';
}

const sx = (x: number) => (x - view.cx) * view.s + W / 2;
const sy = (y: number) => H / 2 - (y - view.cy) * view.s;
const wx = (px: number) => (px - W / 2) / view.s + view.cx;
const wy = (py: number) => view.cy - (py - H / 2) / view.s;

// road and bayou paths in world meters, built once
let roadPaths: Path2D[] = [];
let waterPaths: Path2D[] = [];
let tunnelPath = new Path2D();
function buildPaths(): void {
  roadPaths = city.roadClasses.map(() => new Path2D());
  for (let e = 0; e < city.m; e++) {
    const p = city.edgePoints(e);
    const path = roadPaths[city.eCls[e]];
    path.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i + 1]);
    if (city.eFlags[e] & 2) {
      tunnelPath.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) tunnelPath.lineTo(p[i], p[i + 1]);
    }
  }
  waterPaths = [new Path2D(), new Path2D()];
  for (const line of city.water) {
    const path = waterPaths[line[0] === 2 ? 1 : 0];
    path.moveTo(line[1], line[2]);
    for (let i = 3; i < line.length; i += 2) path.lineTo(line[i], line[i + 1]);
  }
}

// cached base layer (ground, bayous, roads) re-rendered only when the view changes
const base = document.createElement('canvas');
const bctx = base.getContext('2d')!;
let baseKey = '';
function drawBase(): void {
  const key = `${view.cx}|${view.cy}|${view.s}|${W}|${H}|${dpr}`;
  if (key === baseKey) return;
  baseKey = key;
  base.width = canvas.width;
  base.height = canvas.height;
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.fillStyle = C.bg;
  bctx.fillRect(0, 0, base.width, base.height);
  const k = view.s * dpr;
  bctx.setTransform(k, 0, 0, -k, (W / 2 - view.cx * view.s) * dpr, (H / 2 + view.cy * view.s) * dpr);
  bctx.lineCap = 'round';
  bctx.lineJoin = 'round';
  const zoom = view.s / 0.04;
  const widths = [2.4, 2.0, 1.6, 1.3, 1.0, 0.55, 0.55, 0.45];
  for (let c = city.roadClasses.length - 1; c >= 0; c--) {
    bctx.strokeStyle = C.roads[c];
    bctx.globalAlpha = c >= 5 ? Math.min(1, 0.45 + zoom * 0.15) : 1;
    bctx.lineWidth = (widths[c] * Math.min(2.2, Math.max(0.8, Math.sqrt(zoom)))) / view.s;
    bctx.stroke(roadPaths[c]);
  }
  bctx.globalAlpha = 1;
  bctx.strokeStyle = C.water;
  bctx.lineWidth = 1.2 / view.s;
  bctx.stroke(waterPaths[0]);
  bctx.lineWidth = 2.6 / view.s;
  bctx.stroke(waterPaths[1]);
  // hospitals and fire stations
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of city.stations) {
    const x = sx(s.x);
    const y = sy(s.y);
    if (s.kind === 'hospital') {
      bctx.fillStyle = '#f4f7fd';
      bctx.fillRect(x - 4, y - 1.2, 8, 2.4);
      bctx.fillRect(x - 1.2, y - 4, 2.4, 8);
    } else if (s.kind === 'fire') {
      bctx.strokeStyle = '#ffb54799';
      bctx.lineWidth = 1.2;
      bctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    }
  }
}

// flood overlay: one pixel per 75 m terrain cell, redrawn when the water moves
const floodCv = document.createElement('canvas');
let floodStage = -1;
function updateFlood(stage: number): void {
  if (Math.abs(stage - floodStage) < 0.01) return;
  floodStage = stage;
  const { w, h } = city.grid;
  floodCv.width = w;
  floodCv.height = h;
  const fc = floodCv.getContext('2d')!;
  const img = fc.createImageData(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const d = flood.depth(j * w + i, stage);
      if (d < 0.05) continue;
      const o = ((h - 1 - j) * w + i) * 4;
      const f = Math.min(1, d / 2.5);
      img.data[o] = 61 - 40 * f;
      img.data[o + 1] = 139 - 70 * f;
      img.data[o + 2] = 255 - 40 * f;
      img.data[o + 3] = 255 * Math.min(0.72, 0.22 + 0.22 * d);
    }
  }
  fc.putImageData(img, 0, 0);
}

// ------------------------------------------------------------------ replay state at time T

function legAt(legs: ReplayLeg[], t: number): ReplayLeg | null {
  for (const l of legs) if (l.t0 <= t && t < l.t1) return l;
  return null;
}

function unitPos(p: PolicyReplay, u: PolicyReplay['units'][number], t: number): [number, number] {
  let pos: [number, number] = u.home;
  for (const l of u.legs) {
    if (l.t0 > t) break;
    if (l.pts && l.mins) {
      const r = { pts: l.pts, mins: l.mins, total: l.t1 - l.t0 };
      if (t < l.t1) return along(r, t - l.t0);
      pos = [l.pts[l.pts.length - 2], l.pts[l.pts.length - 1]];
    } else if (l.kind === 'scene') {
      const c = p.cads[l.cad];
      pos = [c.x, c.y];
      if (t < l.t1) return pos;
    }
  }
  return pos;
}

type CadState = 'hidden' | 'waiting' | 'assigned' | 'served' | 'void';
function cadState(c: ReplayCad, t: number): CadState {
  if (c.opened > t) return 'hidden';
  if (c.closedAt >= 0 && c.closedAt <= t) return c.outcome === 'served' ? 'served' : 'void';
  if (c.assignedAt >= 0 && c.assignedAt <= t && c.unit >= 0) return 'assigned';
  return 'waiting';
}

// ------------------------------------------------------------------ drawing

function frame(now: number): void {
  if (playing) {
    const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000);
    setTime(Math.min(replay.minutes, T + dt * speed), true);
    if (T >= replay.minutes) setPlaying(false);
  }
  lastFrame = now;
  draw(now);
  requestAnimationFrame(frame);
}
let lastFrame = 0;

function draw(now: number): void {
  drawBase();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // floodwater
  updateFlood(flood.stage(T));
  const [x0, y0] = [city.grid.x0, city.grid.y0];
  const gw = city.grid.w * city.grid.cell;
  const gh = city.grid.h * city.grid.cell;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(floodCv, sx(x0), sy(y0 + gh), gw * view.s, gh * view.s);

  const p = P();
  const pulse = 0.5 + 0.5 * Math.sin(now / 260);
  const unitXY = p.units.map((u) => unitPos(p, u, T));

  // incidents
  for (const c of p.cads) {
    const st = cadState(c, T);
    if (st === 'hidden' || CAN_SERVE[c.type].length === 0) continue;
    const x = sx(c.x);
    const y = sy(c.y);
    if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
    const col = ACU[c.acuity] ?? C.a4;
    if (st === 'served') {
      const age = T - c.closedAt;
      if (age > 30) continue;
      ctx.globalAlpha = 1 - age / 30;
      ctx.fillStyle = C.ok;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }
    if (st === 'void') continue;
    const r = 3 + Math.min(4, c.people * 0.6);
    if (st === 'waiting') {
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.25 + 0.5 * pulse;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 3 + 3 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      const [ux, uy] = unitXY[c.unit];
      ctx.strokeStyle = col + '88';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx(ux), sy(uy));
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (c.id === selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // units
  p.units.forEach((u, i) => {
    const [ux, uy] = unitXY[i];
    const x = sx(ux);
    const y = sy(uy);
    const leg = legAt(u.legs, T);
    const moving = leg && (leg.kind === 'drive' || leg.kind === 'transport');
    ctx.globalAlpha = leg ? 1 : 0.45;
    ctx.fillStyle = C.unit[u.kind];
    const s = moving ? 5 : 3.5;
    if (u.kind === 'rescue') {
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.fill();
    } else ctx.fillRect(x - s / 1.4, y - s / 1.4, s * 1.42, s * 1.42);
    if (leg?.kind === 'turned_back') {
      ctx.strokeStyle = C.a1;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5);
      ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });

  // a call typed in by the viewer
  if (take) {
    if (take.route) {
      ctx.strokeStyle = C.amber;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < take.route.length; i += 2) {
        const f = i === 0 ? ctx.moveTo.bind(ctx) : ctx.lineTo.bind(ctx);
        f(sx(take.route[i]), sy(take.route[i + 1]));
      }
      ctx.stroke();
    }
    const x = sx(take.x);
    const y = sy(take.y);
    ctx.fillStyle = C.amber;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y - 16, 8, Math.PI * 0.8, Math.PI * 2.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1d1300';
    ctx.beginPath();
    ctx.arc(x, y - 16, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------------ time, clock, KPIs

function clock(t: number): string {
  const m = Math.round(22 * 60 + t) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function setTime(t: number, fromPlay = false): void {
  T = Math.max(0, Math.min(replay.minutes, t));
  if (!fromPlay || Math.floor(T * 2) !== Math.floor(lastHud * 2)) hud();
}
let lastHud = -1;

function hud(): void {
  lastHud = T;
  $('clock').textContent = clock(T);
  $('date').textContent = T >= 120 ? 'Sun Aug 27 2017' : 'Sat Aug 26 2017';
  const st = flood.stage(T);
  $('stage').textContent = `+${st.toFixed(1)}`;
  $('stagefill').style.width = `${Math.min(100, (st / 6) * 100)}%`;
  ($('scrub') as HTMLInputElement).value = String(T);
  const s = Pk('surge').series;
  const c = Pk('cad').series;
  const i = Math.min(s.t.length - 1, Math.floor(T / 5));
  const lerp = (a: number[]) => {
    const j = Math.min(a.length - 1, i + 1);
    const f = Math.min(1, (T - s.t[i]) / 5);
    return a[i] + (a[j] - a[i]) * (j === i ? 0 : f);
  };
  kpi('k-deaths', lerp(s.deaths), lerp(c.deaths), 1, true);
  kpi('k-reached', lerp(s.reached), lerp(c.reached), 0, false);
  kpi('k-waiting', s.waiting[i], c.waiting[i], 0, true, false);
  kpi('k-hold', s.onHold[i], c.onHold[i], 0, true, false);
  renderFeed();
  if (selected !== null && $('pane-inc').hidden === false) renderIncident();
  drawTimeline();
}

function kpi(id: string, sv: number, cv: number, dp: number, lowerIsBetter: boolean, pct = true): void {
  const el = $(id);
  el.querySelector('.ks')!.textContent = sv.toFixed(dp);
  el.querySelector('.kc')!.textContent = cv.toFixed(dp);
  const d = el.querySelector('.kdelta')!;
  const diff = sv - cv;
  if (Math.abs(diff) < (dp ? 0.05 : 0.5) || (pct && cv < 0.5)) {
    d.textContent = '';
    d.className = 'kdelta';
    return;
  }
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  d.textContent = pct ? `${diff > 0 ? '+' : '−'}${Math.abs((100 * diff) / cv).toFixed(0)}% with copilot` : `${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(dp)} with copilot`;
  d.className = `kdelta ${good ? 'good' : 'bad'}`;
}

// ------------------------------------------------------------------ timeline

const tl = $<HTMLCanvasElement>('tl');
const tctx = tl.getContext('2d')!;
let tlBase: HTMLCanvasElement | null = null;
function drawTimelineBase(): void {
  const r = tl.getBoundingClientRect();
  const k = Math.min(2, window.devicePixelRatio || 1);
  tl.width = Math.round(r.width * k);
  tl.height = Math.round(r.height * k);
  const b = document.createElement('canvas');
  b.width = tl.width;
  b.height = tl.height;
  const g = b.getContext('2d')!;
  g.scale(k, k);
  const w = r.width;
  const h = r.height;
  const top = 4;
  const bot = h - 14;
  const xt = (t: number) => (t / replay.minutes) * w;
  g.fillStyle = '#111a2e';
  g.fillRect(0, 0, w, h);
  // bayou rise
  g.beginPath();
  g.moveTo(0, bot);
  for (let t = 0; t <= replay.minutes; t += 5) g.lineTo(xt(t), bot - (flood.stage(t) / 6) * (bot - top));
  g.lineTo(w, bot);
  g.closePath();
  g.fillStyle = '#3d8bff33';
  g.fill();
  // expected deaths, both dispatchers
  const max = Math.max(...replay.policies.flatMap((p) => p.series.deaths), 1);
  for (const key of ['cad', 'surge'] as const) {
    const s = Pk(key).series;
    g.beginPath();
    s.t.forEach((t, i) => {
      const y = bot - (s.deaths[i] / max) * (bot - top);
      if (i === 0) g.moveTo(xt(t), y);
      else g.lineTo(xt(t), y);
    });
    g.strokeStyle = key === 'surge' ? C.amber : C.steel;
    g.lineWidth = key === 'surge' ? 2 : 1.5;
    g.stroke();
  }
  g.fillStyle = '#8e9bb6';
  g.font = '10px "IBM Plex Mono", monospace';
  for (let t = 0; t <= replay.minutes; t += 60) {
    const x = Math.min(w - 30, Math.max(0, xt(t) - 14));
    g.fillText(clock(t), x, h - 2);
  }
  tlBase = b;
}

function drawTimeline(): void {
  if (!tlBase) return;
  const k = tl.width / tl.getBoundingClientRect().width || 1;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.drawImage(tlBase, 0, 0);
  const x = (T / replay.minutes) * tl.width;
  tctx.fillStyle = '#e7ecf6';
  tctx.fillRect(x - k, 0, 2 * k, tl.height - 12 * k);
}

// ------------------------------------------------------------------ call feed

let feedKey = '';
const triageCache = new Map<number, Triage>();
function triageOf(i: number): Triage {
  let t = triageCache.get(i);
  if (!t) {
    t = triager.triage(replay.calls[i].text);
    triageCache.set(i, t);
  }
  return t;
}

function renderFeed(): void {
  const list = answered[pol];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= T) lo = mid + 1;
    else hi = mid;
  }
  const key = `${pol}|${lo}|${Math.floor(T)}`;
  if (key === feedKey) return;
  feedKey = key;
  const p = P();
  const items = list.slice(Math.max(0, lo - 30), lo).reverse();
  $('feed').innerHTML = items.length
    ? items.map(([t, i]) => callCard(p, t, i)).join('')
    : '<li class="hint">The first 911 calls arrive in a few minutes. Press play.</li>';
}

function callCard(p: PolicyReplay, t: number, i: number): string {
  const [, cadId, merged] = p.calls[i];
  const cad = p.cads[cadId];
  const text = replay.calls[i].text;
  const chips: string[] = [];
  let body = esc(text);
  if (p.key === 'surge') {
    const tr = triageOf(i);
    body = highlight(text, tr);
    if (tr.address === null) chips.push('<span class="chip">no address · phone location</span>');
  } else chips.push('<span class="chip">coded by call-taker</span>');
  chips.unshift(`<span class="chip ${cad.acuity <= 1 ? 'hot' : ''}">P${cad.acuity}</span>`);
  if (merged) chips.push(`<span class="chip merge">merged into #${cad.id}</span>`);
  if (cad.unit >= 0 && cad.assignedAt >= 0 && cad.assignedAt <= T) chips.push(`<span class="chip go">→ ${esc(p.units[cad.unit].name)}</span>`);
  return `<li class="call acu${Math.min(3, cad.acuity)}" data-cad="${cad.id}">
    <div class="chead"><span class="ctime">${clock(t)}</span><span class="ctype">${TYPE_LABEL[cad.type]}</span><span class="ctime">#${cad.id}</span></div>
    <div class="ctext">${body}</div>
    <div class="cfoot">${chips.join('')}</div></li>`;
}

function highlight(text: string, tr: Triage): string {
  const spans: [number, number, string][] = [];
  const lower = text.toLowerCase();
  for (const e of tr.evidence) {
    let needle = e.text.toLowerCase();
    if (e.kind === 'where') needle = String(tr.address?.number ?? '');
    if (!needle) continue;
    const at = lower.indexOf(needle);
    if (at >= 0 && !spans.some(([a, b]) => at < b && at + needle.length > a)) spans.push([at, at + needle.length, e.kind]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let k = 0;
  for (const [a, b, kind] of spans) {
    out += esc(text.slice(k, a)) + `<mark class="${kind}">${esc(text.slice(a, b))}</mark>`;
    k = b;
  }
  return out + esc(text.slice(k));
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ------------------------------------------------------------------ incident detail

function renderIncident(): void {
  const p = P();
  if (selected === null) return;
  const c = p.cads[selected];
  const st = cadState(c, T);
  const tr = p.key === 'surge' ? triageOf(c.calls[0]) : null;
  const truth = replay.incidents[c.truths[0]];
  const calls = c.calls
    .filter((k) => p.calls[k][0] >= 0 && p.calls[k][0] <= T)
    .map((k) => `<div class="call"><div class="chead"><span class="ctime">${clock(p.calls[k][0])}</span></div><div class="ctext">${tr ? highlight(replay.calls[k].text, triageOf(k)) : esc(replay.calls[k].text)}</div></div>`)
    .join('');
  let outcome = '';
  if (st === 'served') {
    const s = p.survived[c.truths[0]];
    outcome = `<div class="outcome good">Reached at ${clock(c.closedAt)} by ${esc(p.units[c.unit].name)}${s >= 0 ? ` · survival ${(s * 100).toFixed(0)}%` : ''}</div>`;
  } else if (st === 'assigned') outcome = `<div class="outcome wait">${esc(p.units[c.unit].name)} en route since ${clock(c.assignedAt)}</div>`;
  else if (st === 'void') outcome = `<div class="outcome">${c.outcome === 'duplicate' ? 'Duplicate: these people were already rescued' : 'Crew found nobody at this location'}</div>`;
  else outcome = `<div class="outcome bad">Waiting for a unit since ${clock(c.opened)}</div>`;
  const crit = flood.timeToDepth(c.x, c.y, 1.2);
  $('incident').innerHTML = `
    <h3>${TYPE_LABEL[c.type]} · #${c.id}</h3>
    <div class="meta">${tr?.addressText ? esc(tr.addressText) + ' · ' : ''}${c.people} ${c.people === 1 ? 'person' : 'people'} · priority ${c.acuity} · opened ${clock(c.opened)}${c.calls.length > 1 ? ` · ${c.calls.length} calls` : ''}</div>
    ${outcome}
    <div class="block"><div class="blabel">Water at this spot tonight</div>
      <canvas class="spark" id="spark"></canvas>
      <div class="hint">${Number.isFinite(crit) ? `Forecast: chest-deep (1.2 m) at ${clock(crit)}.` : 'Forecast: stays below 1.2 m tonight.'} Now ${flood.depthAt(c.x, c.y, T).toFixed(1)} m.</div>
    </div>
    ${tr ? `<div class="block"><div class="blabel">What the copilot heard</div><div class="cfoot">${tr.evidence.map((e) => `<span class="chip">${esc(e.text)} → ${esc(e.label.replace(/_/g, ' '))}</span>`).join('')}</div></div>` : ''}
    <div class="block"><div class="blabel">Calls</div>${calls || '<div class="hint">No calls answered yet.</div>'}</div>
    ${truth && truth.type !== c.type ? `<div class="block"><div class="hint">Actually: ${TYPE_LABEL[truth.type]}</div></div>` : ''}`;
  sparkline($<HTMLCanvasElement>('spark'), c.x, c.y);
}

function sparkline(cv: HTMLCanvasElement, x: number, y: number): void {
  const r = cv.getBoundingClientRect();
  const k = Math.min(2, window.devicePixelRatio || 1);
  cv.width = r.width * k;
  cv.height = r.height * k;
  const g = cv.getContext('2d')!;
  g.scale(k, k);
  const w = r.width;
  const h = r.height - 12;
  const maxD = 3;
  const yd = (d: number) => h - (Math.min(d, maxD) / maxD) * (h - 4);
  g.strokeStyle = '#24314d';
  g.lineWidth = 1;
  for (const d of [1, 2]) {
    g.beginPath();
    g.moveTo(0, yd(d));
    g.lineTo(w, yd(d));
    g.stroke();
  }
  g.strokeStyle = '#ff5a4e88';
  g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(0, yd(1.2));
  g.lineTo(w, yd(1.2));
  g.stroke();
  g.setLineDash([]);
  g.beginPath();
  g.moveTo(0, h);
  for (let t = 0; t <= replay.minutes; t += 5) g.lineTo((t / replay.minutes) * w, yd(flood.depthAt(x, y, t)));
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = '#3d8bff55';
  g.fill();
  g.fillStyle = '#e7ecf6';
  g.fillRect((T / replay.minutes) * w - 1, 0, 2, h);
  g.fillStyle = '#8e9bb6';
  g.font = '10px "IBM Plex Mono", monospace';
  g.fillText('1 m', 2, yd(1) - 2);
  g.fillText('2 m', 2, yd(2) - 2);
  g.fillText('22:00', 0, r.height - 1);
  g.fillText('04:00', w - 30, r.height - 1);
}

// ------------------------------------------------------------------ take a call

function runTake(): void {
  const text = ($('calltext') as HTMLTextAreaElement).value.trim();
  if (!text) return;
  const t0 = performance.now();
  const tr = triager.triage(text);
  const ms = performance.now() - t0;
  const p = P();
  let rec = '<dd>No unit needed. Route to information line.</dd>';
  take = null;
  let fore = '';
  if (tr.address) {
    const a = tr.address;
    const now = flood.depthAt(a.x, a.y, T);
    const crit = flood.timeToDepth(a.x, a.y, 1.2);
    fore = `<dt>Water</dt><dd>${now.toFixed(1)} m here at ${clock(T)}; ${Number.isFinite(crit) ? (crit <= T ? 'already chest-deep' : `chest-deep by ${clock(crit)}`) : 'stays below chest height tonight'}</dd>`;
    take = { x: a.x, y: a.y, route: null, label: '' };
    const kinds = CAN_SERVE[tr.type];
    if (kinds.length) {
      // the best free unit right now, by real drive time on the flooded roads
      let best: { u: number; tt: number; route: number[] } | null = null;
      const vehicles = new Set(p.units.filter((u) => kinds.includes(u.kind as never)).map((u) => u.vehicle));
      for (const v of vehicles) {
        const s = router.search(a.node, v as 'car', T);
        p.units.forEach((u, i) => {
          if (u.vehicle !== v || !kinds.includes(u.kind as never) || legAt(u.legs, T)) return;
          const [ux, uy] = unitPos(p, u, T);
          const node = nearestNode(ux, uy);
          const tt = s.time[node];
          if (Number.isFinite(tt) && (!best || tt < best.tt)) {
            const r = router.route(s, node);
            if (r) best = { u: i, tt, route: r.pts };
          }
        });
      }
      const b = best as { u: number; tt: number; route: number[] } | null;
      if (b) {
        take.route = b.route;
        rec = `<dd>${esc(p.units[b.u].name)}, ${Math.max(1, Math.round(b.tt))} min on open roads</dd>`;
      } else rec = '<dd>No free unit can reach this address right now. Queue for the next boat.</dd>';
    }
    focusOn(a.x, a.y);
  }
  $('takeout').innerHTML = `<div class="card">
    <div class="big">${TYPE_LABEL[tr.type]}</div>
    <dl class="kv">
      <dt>Priority</dt><dd>P${tr.acuity} · ${(tr.confidence * 100).toFixed(0)}% confident · ${ms.toFixed(1)} ms</dd>
      <dt>Where</dt><dd>${tr.addressText ? esc(tr.addressText) : 'No address heard; use phone location'}</dd>
      <dt>Who</dt><dd>${tr.people} ${tr.people === 1 ? 'person' : 'people'}${Object.entries(tr.vuln).filter(([, v]) => v).map(([k]) => `, ${k}`).join('')}</dd>
      ${tr.reportedDepth !== null ? `<dt>Caller says</dt><dd>about ${tr.reportedDepth} m of water</dd>` : ''}
      ${fore}
      <dt>Send</dt>${rec}
    </dl>
    <div class="ctext">${highlight(text, tr)}</div>
  </div>`;
}

let nodeGrid: Map<string, number[]> | null = null;
function nearestNode(x: number, y: number): number {
  const cell = 400;
  if (!nodeGrid) {
    nodeGrid = new Map();
    for (let i = 0; i < city.n; i++) {
      const k = `${Math.floor(city.nx[i] / cell)},${Math.floor(city.ny[i] / cell)}`;
      (nodeGrid.get(k) ?? nodeGrid.set(k, []).get(k)!).push(i);
    }
  }
  let best = -1;
  let bd = Infinity;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  for (let r = 1; best < 0 && r < 20; r++) {
    for (let i = cx - r; i <= cx + r; i++)
      for (let j = cy - r; j <= cy + r; j++)
        for (const n of nodeGrid.get(`${i},${j}`) ?? []) {
          const d = (city.nx[n] - x) ** 2 + (city.ny[n] - y) ** 2;
          if (d < bd) {
            bd = d;
            best = n;
          }
        }
  }
  return best < 0 ? 0 : best;
}

function focusOn(x: number, y: number): void {
  view.cx = x;
  view.cy = y;
  view.s = Math.max(view.s, 0.12);
  baseKey = '';
}

// ------------------------------------------------------------------ controls

function setPlaying(on: boolean): void {
  playing = on;
  $('play').textContent = on ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on && T >= replay.minutes) setTime(0);
}

function setPolicy(k: 'surge' | 'cad'): void {
  pol = k;
  selected = null;
  $('pol-surge').classList.toggle('on', k === 'surge');
  $('pol-cad').classList.toggle('on', k === 'cad');
  $('pol-surge').setAttribute('aria-selected', String(k === 'surge'));
  $('pol-cad').setAttribute('aria-selected', String(k === 'cad'));
  feedKey = '';
  hud();
}

function setTab(k: 'feed' | 'inc' | 'take'): void {
  for (const t of ['feed', 'inc', 'take']) {
    $(`tab-${t}`).classList.toggle('on', t === k);
    $(`pane-${t}`).hidden = t !== k;
  }
}

function selectCad(id: number): void {
  selected = id;
  setTab('inc');
  renderIncident();
}

function wire(): void {
  window.addEventListener('resize', () => {
    resize();
    drawTimelineBase();
    hud();
  });
  $('play').onclick = () => setPlaying(!playing);
  $('speed').onchange = (e) => (speed = Number((e.target as HTMLSelectElement).value));
  $('scrub').oninput = (e) => setTime(Number((e.target as HTMLInputElement).value));
  $('pol-surge').onclick = () => setPolicy('surge');
  $('pol-cad').onclick = () => setPolicy('cad');
  $('tab-feed').onclick = () => setTab('feed');
  $('tab-inc').onclick = () => {
    setTab('inc');
    renderIncident();
  };
  $('tab-take').onclick = () => setTab('take');
  $('triage').onclick = runTake;
  $('examples').innerHTML = EXAMPLES.map(([l], i) => `<button data-i="${i}">${l}</button>`).join('');
  $('examples').onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    ($('calltext') as HTMLTextAreaElement).value = EXAMPLES[Number(b.dataset.i)][1];
    runTake();
  };
  $('feed').onclick = (e) => {
    const li = (e.target as HTMLElement).closest('li[data-cad]') as HTMLElement | null;
    if (!li) return;
    const c = P().cads[Number(li.dataset.cad)];
    focusOn(c.x, c.y);
    selectCad(c.id);
  };
  $('zin').onclick = () => zoom(1.5, W / 2, H / 2);
  $('zout').onclick = () => zoom(1 / 1.5, W / 2, H / 2);
  $('zfit').onclick = fit;
  $('newstorm').onclick = newStorm;

  // pan, zoom, pinch, tap
  const pts = new Map<number, [number, number]>();
  let moved = 0;
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.offsetX, e.offsetY]);
    moved = 0;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    canvas.classList.add('drag');
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    pts.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch > 0) zoom(d / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pinch = d;
      moved += 10;
      return;
    }
    const dx = e.offsetX - prev[0];
    const dy = e.offsetY - prev[1];
    moved += Math.abs(dx) + Math.abs(dy);
    view.cx -= dx / view.s;
    view.cy += dy / view.s;
    baseKey = '';
  });
  const up = (e: PointerEvent) => {
    if (pts.has(e.pointerId) && pts.size === 1 && moved < 5) tap(e.offsetX, e.offsetY);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = 0;
    if (!pts.size) canvas.classList.remove('drag');
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
    },
    { passive: false },
  );
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!playing);
    }
  });
}

function zoom(f: number, px: number, py: number): void {
  const x = wx(px);
  const y = wy(py);
  view.s = Math.min(1.5, Math.max(0.01, view.s * f));
  view.cx = x - (px - W / 2) / view.s;
  view.cy = y + (py - H / 2) / view.s;
  baseKey = '';
}

function tap(px: number, py: number): void {
  const p = P();
  let best = -1;
  let bd = 16 * 16;
  for (const c of p.cads) {
    const st = cadState(c, T);
    if (st === 'hidden' || st === 'void' || (st === 'served' && T - c.closedAt > 30) || CAN_SERVE[c.type].length === 0) continue;
    const d = (sx(c.x) - px) ** 2 + (sy(c.y) - py) ** 2;
    if (d < bd) {
      bd = d;
      best = c.id;
    }
  }
  if (best >= 0) selectCad(best);
}

// ------------------------------------------------------------------ another storm, in a worker

function newStorm(): void {
  const btn = $<HTMLButtonElement>('newstorm');
  btn.disabled = true;
  btn.textContent = 'Simulating… 0%';
  const worker = new Worker(URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' })));
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.progress !== undefined) btn.textContent = `Simulating… ${Math.round(m.progress * 100)}%`;
    if (m.replay) {
      replay = m.replay as Replay;
      triageCache.clear();
      selected = null;
      indexReplay();
      setTime(0);
      setPlaying(true);
      btn.disabled = false;
      btn.textContent = `Storm #${replay.seed} · simulate another`;
      worker.terminate();
    }
  };
  worker.postMessage({ city: CITY_SRC, seed: 1 + Math.floor(Math.random() * 1e6) });
}

// ------------------------------------------------------------------ explainer

function renderAbout(): void {
  $('sources').innerHTML = [
    ...city.sources,
    'Houston 911 call volume during Harvey: Associated Press, August 28, 2017 (56,000+ calls in 17 hours; about 8,000 on a normal day)',
  ]
    .map((s) => `<li>${esc(s)}</li>`)
    .join('');
  const b = __BENCH__;
  if (!b) {
    $('bench').innerHTML = '<tr><td>Run <code>npm run bench</code> to fill this table.</td></tr>';
    return;
  }
  $('bseeds').textContent = String(b.seeds);
  $('bunits').textContent = String(b.units);
  $('bench').innerHTML =
    '<thead><tr><th>Dispatcher</th><th>Expected deaths</th><th>Incidents reached</th><th>Life-threat median (min)</th><th>Life-threat p90 (min)</th><th>Turned back by water</th><th>Wasted trips</th></tr></thead><tbody>' +
    b.rows
      .map(
        (r) =>
          `<tr class="${r.policy === 'Surge copilot' ? 'me' : ''}"><td>${esc(r.policy)}</td><td>${r.deaths.toFixed(1)} ± ${r.ci.toFixed(1)}</td><td>${r.reached.toFixed(0)}</td><td>${r.p1Median.toFixed(1)}</td><td>${r.p1P90.toFixed(1)}</td><td>${r.turnedBack.toFixed(0)}</td><td>${r.wasted.toFixed(1)}</td></tr>`,
      )
      .join('') +
    '</tbody>';
}
