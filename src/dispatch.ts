import type { City } from './city';
import type { FloodModel, VehicleKind } from './flood';
import { assignMax } from './hungarian';
import { type RiskInput, survival } from './outcomes';
import type { Cad, Policy, Sim } from './sim';
import { type Triage, Triager } from './triage';
import { CAN_SERVE, type Call, type IncidentType, PROTOCOL_PRIORITY, type UnitKind, type Vulnerability } from './types';

/**
 * Two conventional baselines and the copilot.
 *
 * fifo   - every call gets the closest free unit in the order calls were answered.
 * cad    - what a modern CAD does: protocol priority (P1/P2/P3), first-come within a priority,
 *          closest free unit by straight-line distance (AVL) that has not already been turned back by water there, duplicates merged when the address or the
 *          caller's phone number matches an open incident. A human call-taker codes the incident type
 *          correctly and gets the address right whenever the caller says it.
 * cad+   - the same CAD, but choosing units by drive time on the flooded network instead of straight-line distance.
 * surge  - the copilot: machine triage of the transcript, duplicate detection, a flood-aware risk forecast
 *          for every open incident, and optimal assignment over real drive times on the flooded network.
 */

const NO_VULN: Vulnerability = { elderly: false, infant: false, mobility: false, medical: false };

/** Location for a call when the caller gave no address: the nearest known address to the phone's location fix. */
function locate(sim: Sim, x: number, y: number): { x: number; y: number; node: number } {
  let best = sim.city.addresses[0];
  let bd = Infinity;
  for (const a of sim.city.addresses) {
    const d = (a.x - x) ** 2 + (a.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return { x: best.x, y: best.y, node: best.node };
}

/** How a human call-taker enters the call: correct type, correct address if spoken, otherwise the phone's location fix. */
function humanIntake(call: Call, now: number, sim: Sim): void {
  const inc = sim.scenario.incidents[call.incident];
  const addr = call.addressGiven ? sim.city.addresses[inc.address] : null;
  const loc = addr ? { x: addr.x, y: addr.y, node: addr.node } : locate(sim, call.aliX, call.aliY);
  const dup = sim.openCads().find((c) => c.calls.some((k) => sim.scenario.calls[k].phone === call.phone) || (addr && c.addressId === addr.id));
  if (dup) return sim.mergeCad(call, dup);
  sim.openCad(call, now, {
    type: inc.type,
    acuity: PROTOCOL_PRIORITY[inc.type],
    ...loc,
    addressId: addr ? addr.id : null,
    people: 1,
    vuln: NO_VULN,
    reportedDepth: null,
  });
}

function closestUnitPolicy(name: string, order: (a: Cad, b: Cad) => number, byDriveTime = false): Policy {
  return {
    name,
    intake: humanIntake,
    dispatch(now, sim) {
      const out: [number, number][] = [];
      const idle = sim.idleUnits();
      if (!idle.length) return out;
      const taken = new Set<number>();
      const waiting = sim.cads.filter((c) => c.status === 'waiting').sort(order);
      for (const cad of waiting) {
        let best = -1;
        let bd = Infinity;
        const times = new Map<string, Float32Array>();
        for (const u of idle) {
          if (taken.has(u.id) || !CAN_SERVE[cad.type].includes(u.kind) || cad.blocked.includes(u.vehicle)) continue;
          if (byDriveTime && !times.has(u.vehicle)) times.set(u.vehicle, sim.timesTo(cad.node, u.vehicle, now));
          const d = byDriveTime ? times.get(u.vehicle)![u.node] : Math.hypot(sim.city.nx[u.node] - cad.x, sim.city.ny[u.node] - cad.y);
          if (d < bd) {
            bd = d;
            best = u.id;
          }
        }
        if (best >= 0) {
          taken.add(best);
          out.push([best, cad.id]);
        }
      }
      return out;
    },
  };
}

export const fifoPolicy = (): Policy => closestUnitPolicy('First come, first served', (a, b) => a.opened - b.opened);
export const cadPolicy = (): Policy => closestUnitPolicy('Standard CAD', (a, b) => a.acuity - b.acuity || a.opened - b.opened);
/** The strongest baseline: standard CAD, but picking the unit with the shortest drive on the flooded road network. */
export const cadRoutedPolicy = (): Policy => closestUnitPolicy('CAD + flood routing', (a, b) => a.acuity - b.acuity || a.opened - b.opened, true);

/** How far ahead the copilot looks when weighing "send now" against "wait for the next free unit" (minutes). */
const HORIZON = 120;
/** Incidents shortlisted per kind of free unit in each assignment round. */
const TOP_K = 24;
const MAX_TRAVEL = 75;
/** Value of the right tool: a boat for a rescue, an ambulance for a patient. Second-choice units count for less. */
const PREF = [1, 0.85, 0.85];
/**
 * Opportunity cost of one unit-minute, in expected lives. A crew driving across town is a crew that cannot
 * take the next call, so the optimizer only sends a far unit when the incident is worth it.
 */
const UNIT_MINUTE = 0.01;

export interface SurgeOptions {
  /** Use the terrain flood forecast when judging urgency (turn off to measure what it is worth). */
  forecast?: boolean;
  name?: string;
}

/** What the copilot knows about an open incident. The simulator's CAD entries and the live center's incidents both fit. */
export interface OpenIncident {
  id: number;
  opened: number;
  type: IncidentType;
  acuity: number;
  x: number;
  y: number;
  node: number;
  people: number;
  vuln: Vulnerability;
  reportedDepth: number | null;
}

export interface FreeUnit {
  id: number;
  kind: UnitKind;
  vehicle: VehicleKind;
  node: number;
}

export interface Pick {
  unit: number;
  incident: number;
  /** Drive time on the flooded network (minutes). */
  minutes: number;
  /** Expected lives saved by sending this unit now rather than later. */
  gain: number;
}

export interface PlanContext {
  flood: FloodModel;
  /** Drive minutes from every road node to `node` for this vehicle at time t. */
  timesTo(node: number, vehicle: VehicleKind, t: number): Float32Array;
  forecast?: boolean;
  /** Vehicle kinds already turned back by water at an incident; never recommend them there again. */
  blocked?: (incident: number, vehicle: VehicleKind) => boolean;
}

/** Expected lives saved by reaching this incident `tt` minutes from now instead of HORIZON minutes later. */
export function lifeGain(c: OpenIncident, flood: FloodModel, now: number, tt: number, forecast = true): number {
  const r: RiskInput = {
    type: c.type,
    vuln: c.vuln,
    severity: 1,
    depthAt: (t) => Math.max(c.reportedDepth ?? 0, forecast ? flood.depthAt(c.x, c.y, t) : 0),
  };
  const t0 = c.opened - 4;
  const g = c.people * (survival(r, t0, now + tt) - survival(r, t0, now + tt + HORIZON));
  // a small aging term so nobody waits forever behind a stream of urgent calls
  return g + 0.0004 * c.people * (now - c.opened) + 1e-6 * (5 - c.acuity);
}

/**
 * One copilot round: the optimal assignment of free units to waiting incidents, maximizing expected lives saved
 * minus the opportunity cost of each crew's drive time on the flooded road network.
 */
export function planAssignments(free: FreeUnit[], waiting: OpenIncident[], now: number, ctx: PlanContext): Pick[] {
  if (!free.length || !waiting.length) return [];
  const forecast = ctx.forecast ?? true;
  const gain = (c: OpenIncident, tt: number) => lifeGain(c, ctx.flood, now, tt, forecast);
  // shortlist the most urgent incidents each kind of free unit could take, so a queue full of
  // boat-only rescues never starves the patrol cars and ambulances that could be working
  const scored = waiting.map((c) => ({ c, g: gain(c, 0) })).sort((a, b) => b.g - a.g);
  const shortlist = new Set<OpenIncident>();
  for (const kind of new Set(free.map((u) => u.kind))) {
    let n = 0;
    for (const { c } of scored) {
      if (n >= TOP_K) break;
      if (CAN_SERVE[c.type].includes(kind)) {
        shortlist.add(c);
        n++;
      }
    }
  }
  const ranked = [...shortlist];
  const vehicles = [...new Set(free.map((u) => u.vehicle))];
  const units = free.filter((u) => ranked.some((c) => CAN_SERVE[c.type].includes(u.kind)));
  const times = new Map<string, Float32Array>();
  for (const c of ranked) for (const v of vehicles) times.set(`${c.id}|${v}`, ctx.timesTo(c.node, v, now));
  const tt = (u: FreeUnit, c: OpenIncident) => times.get(`${c.id}|${u.vehicle}`)![u.node];
  const value = units.map((u) =>
    ranked.map((c) => {
      const pref = CAN_SERVE[c.type].indexOf(u.kind);
      if (pref < 0 || ctx.blocked?.(c.id, u.vehicle)) return -Infinity;
      const t = tt(u, c);
      if (!Number.isFinite(t) || t > MAX_TRAVEL) return -Infinity;
      // prefer the right tool (a boat for a rescue), and tie-break toward shorter drives
      return gain(c, t) * PREF[pref] - t * UNIT_MINUTE;
    }),
  );
  const out: Pick[] = [];
  assignMax(value).forEach((j, i) => {
    if (j >= 0) out.push({ unit: units[i].id, incident: ranked[j].id, minutes: tt(units[i], ranked[j]), gain: gain(ranked[j], tt(units[i], ranked[j])) });
  });
  return out;
}

/**
 * Duplicate detection: same phone, same address, or (no address given) a compatible open incident
 * inside the caller's location fix opened in the last two hours.
 */
export function findDuplicate<T extends OpenIncident & { addressId: number | null }>(
  open: T[],
  tr: Triage,
  caller: { phone?: string; x?: number; y?: number; r?: number },
  phonesOf: (c: T) => string[],
  now: number,
): T | undefined {
  const a = tr.address;
  return (
    (caller.phone ? open.find((c) => phonesOf(c).includes(caller.phone!)) : undefined) ??
    (a ? open.find((c) => (a.id >= 0 && c.addressId === a.id) || Math.hypot(c.x - a.x, c.y - a.y) < 25) : undefined) ??
    (!a && caller.x !== undefined && caller.y !== undefined
      ? open.find((c) => c.type === tr.type && Math.hypot(c.x - caller.x!, c.y - caller.y!) < (caller.r ?? 0) + 100 && now - c.opened < 120)
      : undefined)
  );
}

/** A repeat call escalates the incident: keep the worst news. */
export function escalate(c: OpenIncident & { status: string }, tr: Triage): void {
  if (tr.reportedDepth !== null) c.reportedDepth = Math.max(c.reportedDepth ?? 0, tr.reportedDepth);
  c.people = Math.max(c.people, tr.people);
  for (const k of Object.keys(c.vuln) as (keyof Vulnerability)[]) c.vuln[k] ||= tr.vuln[k];
  if (tr.acuity < c.acuity && CAN_SERVE[tr.type].length) {
    c.acuity = tr.acuity;
    if (c.status === 'waiting') c.type = tr.type;
  }
}

export function surgePolicy(city: City, opts: SurgeOptions = {}): Policy & { triager: Triager } {
  const forecast = opts.forecast ?? true;
  const triager = new Triager(city);
  let lastRound = -Infinity;
  let dirty = true;

  return {
    name: opts.name ?? 'Surge copilot',
    triager,
    intake(call, now, sim) {
      const tr = triager.triage(call.transcript, call.aliX, call.aliY);
      const loc = tr.address ? { x: tr.address.x, y: tr.address.y, node: tr.address.node } : locate(sim, call.aliX, call.aliY);
      dirty = true;
      const dup = findDuplicate(sim.openCads(), tr, { phone: call.phone, x: call.aliX, y: call.aliY, r: call.aliR }, (c) => c.calls.map((k) => sim.scenario.calls[k].phone), now);
      if (dup) {
        sim.mergeCad(call, dup);
        escalate(dup, tr);
        if (dup.addressId === null && tr.address) Object.assign(dup, { addressId: tr.address.id, ...loc });
        return;
      }
      const cad = sim.openCad(call, now, {
        type: tr.type,
        acuity: tr.acuity,
        ...loc,
        addressId: tr.address ? tr.address.id : null,
        people: tr.people,
        vuln: { ...tr.vuln },
        reportedDepth: tr.reportedDepth,
        triage: tr,
      });
      cad.triage = tr;
    },

    dispatch(now, sim) {
      // re-plan when something changed, and at least every few minutes as the water rises
      if (!dirty && now - lastRound < 3) return [];
      const idle = sim.idleUnits();
      const waiting = sim.cads.filter((c) => c.status === 'waiting');
      if (!idle.length || !waiting.length) return [];
      dirty = false;
      lastRound = now;
      const out = planAssignments(idle, waiting, now, { flood: sim.flood, timesTo: (n, v, t) => sim.timesTo(n, v, t), forecast }).map((p) => [p.unit, p.incident] as [number, number]);
      if (out.length) dirty = true;
      return out;
    },
  };
}
