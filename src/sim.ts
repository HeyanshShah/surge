import type { City } from './city';
import { type FloodModel, type VehicleKind } from './flood';
import { type RiskInput, survival } from './outcomes';
import { mix32 } from './rng';
import { type Route, Router } from './routing';
import type { Scenario } from './scenario';
import type { Triage } from './triage';
import { CAN_SERVE, type Call, type Incident, type IncidentType, type UnitKind, type Vulnerability } from './types';

/**
 * Discrete-time simulation of one 911 center through the surge.
 * Calls ring, wait on hold (and hang up when they wait too long), get answered by a fixed pool of call-takers,
 * and become incidents in the dispatcher's queue (CAD). A dispatch policy sends units, which drive the real road
 * network with roads closing as the water rises. Ground truth decides who survives.
 * Every policy sees exactly the same storm, the same calls and the same call-takers.
 */

export interface UnitSpec {
  kind: UnitKind;
  vehicle: VehicleKind;
  station: number;
  name: string;
}

export interface Unit extends UnitSpec {
  id: number;
  node: number;
  busy: boolean;
  cad: number;
  legs: Leg[];
}

export interface Leg {
  t0: number;
  t1: number;
  kind: 'drive' | 'scene' | 'transport' | 'turned_back';
  cad: number;
  /** Route polyline for movement legs. */
  route?: Route;
}

/** The dispatcher's view of an emergency: built only from what callers said. */
export interface Cad {
  id: number;
  opened: number;
  calls: number[];
  type: IncidentType;
  acuity: number;
  x: number;
  y: number;
  node: number;
  addressId: number | null;
  people: number;
  vuln: Vulnerability;
  reportedDepth: number | null;
  status: 'waiting' | 'assigned' | 'closed';
  unit: number;
  assignedAt: number;
  closedAt: number;
  /** Ground-truth incidents this CAD entry is actually about (hidden from policies). */
  truths: number[];
  outcome?: 'served' | 'duplicate' | 'wrong_location' | 'no_dispatch';
  /** Vehicle kinds that already tried to reach this incident and were turned back by water. */
  blocked: VehicleKind[];
  triage?: Triage;
}

export interface CallRecord {
  call: number;
  rang: number[];
  answered: number;
  abandoned: number;
  cad: number;
  merged: boolean;
  suppressed: boolean;
}

export interface Policy {
  name: string;
  /** A call-taker finished a call; turn it into a new CAD entry or attach it to an open one. */
  intake(call: Call, now: number, sim: Sim): void;
  /** Pick (unit, cad) pairs to dispatch now. */
  dispatch(now: number, sim: Sim): [number, number][];
}

export interface Metrics {
  policy: string;
  people: number;
  deaths: number;
  preventableDeaths: number;
  incidentsServed: number;
  incidentsUnserved: number;
  /** Minutes from first call to a unit arriving, for life-threatening incidents. */
  p1ResponseMedian: number;
  p1ResponseP90: number;
  p1Unreached: number;
  duplicateTrips: number;
  wrongLocationTrips: number;
  turnedBack: number;
  callsAnswered: number;
  callsAbandoned: number;
  repeatCalls: number;
  callsSuppressed: number;
  cadEntries: number;
}

export const DT = 0.5;
const ON_SCENE: Partial<Record<IncidentType, number>> = { water_rescue: 18, vehicle_in_water: 15, fire: 35, gas_leak: 20, crime: 20, welfare: 15 };
const MEDIC_SCENE = 14;
const HOSPITAL_HANDOFF = 15;
const TURN_BACK = 12;
/** A crew on scene finds an emergency if it is within this distance of where they were sent. */
const FIND_RADIUS = 200;

export class Sim {
  readonly router: Router;
  readonly units: Unit[];
  readonly cads: Cad[] = [];
  readonly calls: CallRecord[];
  readonly resolvedAt: Float64Array;
  readonly survived: Float64Array;
  readonly firstCall: Float64Array;
  now = 0;
  private nextRing = 0;
  private hold: { call: number; since: number; patience: number; tries: number }[] = [];
  private redial: { call: number; at: number; tries: number }[] = [];
  private takers: { call: number; until: number }[];
  private events: { t: number; unit: number; kind: 'arrive' | 'free' }[] = [];
  private searchCache = new Map<string, Float32Array>();
  readonly hospitals: number[];
  counters = { duplicateTrips: 0, wrongLocationTrips: 0, turnedBack: 0, abandoned: 0, suppressed: 0, repeat: 0 };

  constructor(
    readonly city: City,
    readonly flood: FloodModel,
    readonly scenario: Scenario,
    readonly policy: Policy,
    fleet: UnitSpec[],
    router?: Router,
  ) {
    this.router = router ?? new Router(city, flood);
    this.units = fleet.map((u, id) => ({ ...u, id, node: city.stations[u.station].node, busy: false, cad: -1, legs: [] }));
    this.calls = scenario.calls.map((c) => ({ call: c.id, rang: [], answered: -1, abandoned: 0, cad: -1, merged: false, suppressed: false }));
    const n = scenario.incidents.length;
    this.resolvedAt = new Float64Array(n).fill(Infinity);
    this.survived = new Float64Array(n).fill(NaN);
    this.firstCall = new Float64Array(n).fill(Infinity);
    for (const c of scenario.calls) this.firstCall[c.incident] = Math.min(this.firstCall[c.incident], c.t);
    this.takers = Array.from({ length: scenario.callTakers }, () => ({ call: -1, until: 0 }));
    this.hospitals = city.stations.filter((s) => s.kind === 'hospital').map((s) => s.node);
  }

  get done(): boolean {
    return this.now >= this.scenario.minutes;
  }

  run(): Metrics {
    while (!this.done) this.step();
    return this.metrics();
  }

  step(): void {
    const t = this.now;
    const sc = this.scenario;

    // unit arrivals and crews becoming free
    this.events.sort((a, b) => a.t - b.t);
    while (this.events.length && this.events[0].t <= t) this.handle(this.events.shift()!);

    // phones ring; nobody calls about an emergency that has already been handled
    while (this.nextRing < sc.calls.length && sc.calls[this.nextRing].t <= t) {
      const c = sc.calls[this.nextRing++];
      this.ring(c.id, c.t, 0);
    }
    for (let i = this.redial.length - 1; i >= 0; i--) {
      const r = this.redial[i];
      if (r.at <= t) {
        this.redial.splice(i, 1);
        this.ring(r.call, r.at, r.tries);
      }
    }

    // callers on hold give up
    this.hold = this.hold.filter((h) => {
      if (t - h.since <= h.patience) return true;
      this.counters.abandoned++;
      this.calls[h.call].abandoned++;
      if (h.tries < 2) this.redial.push({ call: h.call, at: t + 3 + 5 * rand(h.call, 7 + h.tries), tries: h.tries + 1 });
      return false;
    });

    // call-takers finish calls and pick up the next one on hold
    for (const k of this.takers) {
      if (k.call >= 0 && k.until <= t) {
        const call = sc.calls[k.call];
        this.calls[k.call].answered = t;
        k.call = -1;
        if (this.resolvedAt[call.incident] <= t) this.calls[call.id].suppressed = true;
        else this.policy.intake(call, t, this);
      }
      if (k.call < 0 && this.hold.length) {
        const h = this.hold.shift()!;
        k.call = h.call;
        k.until = t + 1.2 + 1.8 * rand(h.call, 3);
      }
    }

    for (const [u, c] of this.policy.dispatch(t, this)) this.assign(u, c, t);
    this.now = t + DT;
  }

  private ring(call: number, t: number, tries: number): void {
    const c = this.scenario.calls[call];
    if (this.resolvedAt[c.incident] <= t) {
      this.calls[call].suppressed = true;
      this.counters.suppressed++;
      return;
    }
    if (c.attempt > 1 && tries === 0) this.counters.repeat++;
    this.calls[call].rang.push(t);
    this.hold.push({ call, since: t, patience: c.patience, tries });
  }

  // ------------------------------------------------------------ CAD operations used by policies

  openCad(call: Call, now: number, f: Omit<Cad, 'id' | 'opened' | 'calls' | 'status' | 'unit' | 'assignedAt' | 'closedAt' | 'truths' | 'blocked'>): Cad {
    const cad: Cad = { ...f, id: this.cads.length, opened: now, calls: [call.id], status: 'waiting', unit: -1, assignedAt: -1, closedAt: -1, truths: [call.incident], blocked: [] };
    this.cads.push(cad);
    this.calls[call.id].cad = cad.id;
    if (CAN_SERVE[cad.type].length === 0) this.close(cad, now, 'no_dispatch');
    return cad;
  }

  mergeCad(call: Call, cad: Cad): void {
    cad.calls.push(call.id);
    if (!cad.truths.includes(call.incident)) cad.truths.push(call.incident);
    this.calls[call.id].cad = cad.id;
    this.calls[call.id].merged = true;
  }

  close(cad: Cad, now: number, outcome: Cad['outcome']): void {
    cad.status = 'closed';
    cad.closedAt = now;
    cad.outcome = outcome;
  }

  openCads(): Cad[] {
    return this.cads.filter((c) => c.status !== 'closed');
  }

  idleUnits(): Unit[] {
    return this.units.filter((u) => !u.busy);
  }

  /** Travel minutes from every node to `node` for a vehicle kind, with the roads closed at time t (cached per 10 minutes). */
  timesTo(node: number, vehicle: VehicleKind, t: number): Float32Array {
    const key = `${node}|${vehicle}|${Math.floor(t / 10)}`;
    let v = this.searchCache.get(key);
    if (!v) {
      v = Float32Array.from(this.router.search(node, vehicle, Math.floor(t / 10) * 10 + 5).time);
      if (this.searchCache.size > 400) this.searchCache.delete(this.searchCache.keys().next().value!);
      this.searchCache.set(key, v);
    }
    return v;
  }

  // ------------------------------------------------------------ units

  private assign(uid: number, cid: number, t: number): void {
    const u = this.units[uid];
    const cad = this.cads[cid];
    if (u.busy || cad.status !== 'waiting') return;
    u.busy = true;
    u.cad = cid;
    cad.status = 'assigned';
    cad.unit = uid;
    cad.assignedAt = t;
    const s = this.router.search(cad.node, u.vehicle, t);
    const route = this.router.route(s, u.node);
    if (!route) {
      // the crew finds the way under water and has to turn around
      this.counters.turnedBack++;
      u.legs.push({ t0: t, t1: t + TURN_BACK, kind: 'turned_back', cad: cid });
      cad.status = 'waiting';
      cad.unit = -1;
      if (!cad.blocked.includes(u.vehicle)) cad.blocked.push(u.vehicle);
      this.events.push({ t: t + TURN_BACK, unit: uid, kind: 'free' });
      return;
    }
    u.legs.push({ t0: t, t1: t + route.total, kind: 'drive', cad: cid, route });
    this.events.push({ t: t + route.total, unit: uid, kind: 'arrive' });
  }

  private handle(ev: { t: number; unit: number; kind: 'arrive' | 'free' }): void {
    const u = this.units[ev.unit];
    if (ev.kind === 'free') {
      u.busy = false;
      u.cad = -1;
      return;
    }
    const cad = this.cads[u.cad];
    u.node = cad.node;
    const t = ev.t;
    // who is actually here?
    const sc = this.scenario;
    let found: Incident | null = null;
    let alreadyDone = false;
    for (const id of cad.truths) {
      const inc = sc.incidents[id];
      if (Math.hypot(inc.x - cad.x, inc.y - cad.y) > FIND_RADIUS) continue;
      if (this.resolvedAt[id] <= t) {
        alreadyDone = true;
        continue;
      }
      if (!CAN_SERVE[inc.type].includes(u.kind)) continue;
      this.resolvedAt[id] = t;
      this.survived[id] = survival(truthRisk(inc, this.flood), inc.t0, t);
      found ??= inc;
    }
    if (!found) {
      if (alreadyDone) this.counters.duplicateTrips++;
      else this.counters.wrongLocationTrips++;
      this.close(cad, t, alreadyDone ? 'duplicate' : 'wrong_location');
      this.events.push({ t, unit: u.id, kind: 'free' });
      return;
    }
    this.close(cad, t, 'served');
    const scene = u.kind === 'medic' ? MEDIC_SCENE : (ON_SCENE[found.type] ?? 15) + (found.type === 'water_rescue' ? 3 * found.people : 0);
    u.legs.push({ t0: t, t1: t + scene, kind: 'scene', cad: cad.id });
    let free = t + scene;
    if (u.kind === 'medic') {
      const leg = this.transport(u, t + scene);
      if (leg) {
        u.legs.push(leg);
        u.node = leg.route ? this.hospitalAt(leg.route) : u.node;
        free = leg.t1 + HOSPITAL_HANDOFF;
      }
    }
    this.events.push({ t: free, unit: u.id, kind: 'free' });
  }

  private transport(u: Unit, t: number): Leg | null {
    const s = this.router.search(u.node, u.vehicle, t);
    let best = -1;
    for (const h of this.hospitals) if (Number.isFinite(s.time[h]) && (best < 0 || s.time[h] < s.time[best])) best = h;
    if (best < 0) return null;
    const back = this.router.route(s, best)!;
    return { t0: t, t1: t + back.total, kind: 'transport', cad: u.cad, route: reverse(back) };
  }

  private hospitalAt(r: Route): number {
    const x = r.pts[r.pts.length - 2];
    const y = r.pts[r.pts.length - 1];
    let best = this.hospitals[0];
    for (const h of this.hospitals) if (Math.hypot(this.city.nx[h] - x, this.city.ny[h] - y) < Math.hypot(this.city.nx[best] - x, this.city.ny[best] - y)) best = h;
    return best;
  }

  metrics(): Metrics {
    const sc = this.scenario;
    const end = sc.minutes + 60;
    let people = 0;
    let deaths = 0;
    let prevent = 0;
    let served = 0;
    let unserved = 0;
    const p1: number[] = [];
    let p1Unreached = 0;
    for (const inc of sc.incidents) {
      if (CAN_SERVE[inc.type].length === 0 || !Number.isFinite(this.firstCall[inc.id])) continue;
      const risk = truthRisk(inc, this.flood);
      const best = survival(risk, inc.t0, inc.t0);
      const s = Number.isNaN(this.survived[inc.id]) ? survival(risk, inc.t0, Math.max(end, inc.t0)) : this.survived[inc.id];
      people += inc.people;
      deaths += inc.people * (1 - s);
      prevent += inc.people * (best - s);
      if (Number.isFinite(this.resolvedAt[inc.id])) served++;
      else unserved++;
      if (isLifeThreat(inc.type)) {
        if (Number.isFinite(this.resolvedAt[inc.id])) p1.push(this.resolvedAt[inc.id] - this.firstCall[inc.id]);
        else p1Unreached++;
      }
    }
    p1.sort((a, b) => a - b);
    return {
      policy: this.policy.name,
      people,
      deaths,
      preventableDeaths: prevent,
      incidentsServed: served,
      incidentsUnserved: unserved,
      p1ResponseMedian: p1.length ? p1[Math.floor(p1.length / 2)] : NaN,
      p1ResponseP90: p1.length ? p1[Math.floor(p1.length * 0.9)] : NaN,
      p1Unreached,
      duplicateTrips: this.counters.duplicateTrips,
      wrongLocationTrips: this.counters.wrongLocationTrips,
      turnedBack: this.counters.turnedBack,
      callsAnswered: this.calls.filter((c) => c.answered >= 0).length,
      callsAbandoned: this.counters.abandoned,
      repeatCalls: this.counters.repeat,
      callsSuppressed: this.counters.suppressed,
      cadEntries: this.cads.length,
    };
  }
}

export function isLifeThreat(t: IncidentType): boolean {
  return t === 'water_rescue' || t === 'vehicle_in_water' || t === 'cardiac_arrest' || t === 'fire' || t === 'breathing';
}

export function truthRisk(inc: Incident, flood: FloodModel): RiskInput {
  return { type: inc.type, vuln: inc.vuln, severity: inc.severity, depthAt: (t) => flood.depthAt(inc.x, inc.y, t) };
}

function reverse(r: Route): Route {
  const pts: number[] = [];
  const mins: number[] = [];
  for (let i = r.mins.length - 1; i >= 0; i--) {
    pts.push(r.pts[2 * i], r.pts[2 * i + 1]);
    mins.push(r.total - r.mins[i]);
  }
  return { pts, mins, total: r.total };
}

/** Deterministic per-call randomness, so every policy sees identical call-taker behavior. */
function rand(call: number, salt: number): number {
  return mix32(mix32(call * 7919 + salt)) / 4294967296;
}

/** Fire stations host engines and ambulances; a few host high-water rescue teams with boats; police stations host patrol cars. */
export function defaultFleet(city: City, opts: { rescueTeams?: number; medicShare?: number } = {}): UnitSpec[] {
  const fleet: UnitSpec[] = [];
  const fire = city.stations.filter((s) => s.kind === 'fire');
  const police = city.stations.filter((s) => s.kind === 'police');
  const rescueEvery = Math.max(1, Math.round(fire.length / (opts.rescueTeams ?? 22)));
  const medicEvery = 1 / (opts.medicShare ?? 0.7);
  fire.forEach((s, i) => {
    const short = s.name.replace(/Houston Fire (Station|Department Station)/, 'Station').replace(/ Fire Department$/, '');
    fleet.push({ kind: 'engine', vehicle: 'highwater', station: s.id, name: `Engine · ${short}` });
    if (Math.floor(i / medicEvery) !== Math.floor((i + 1) / medicEvery)) fleet.push({ kind: 'medic', vehicle: 'car', station: s.id, name: `Medic · ${short}` });
    if (i % rescueEvery === 0) fleet.push({ kind: 'rescue', vehicle: 'boat', station: s.id, name: `Boat · ${short}` });
  });
  police.forEach((s) => {
    fleet.push({ kind: 'police', vehicle: 'car', station: s.id, name: `Patrol · ${s.name}` });
    fleet.push({ kind: 'police', vehicle: 'car', station: s.id, name: `Patrol · ${s.name}` });
  });
  return fleet;
}
