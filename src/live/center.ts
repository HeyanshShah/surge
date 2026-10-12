import type { City } from '../city';
import { escalate, findDuplicate, type OpenIncident, type Pick, planAssignments } from '../dispatch';
import { DEPTH_LIMIT, type FloodModel, type VehicleKind } from '../flood';
import { Router } from '../routing';
import { type UnitSpec, defaultFleet } from '../sim';
import { type Triage, Triager } from '../triage';
import { CAN_SERVE, TYPE_LABEL, type UnitKind } from '../types';
import { lonLatToXY } from './gauges';

/**
 * A live dispatch board: real calls come in as text (from a call-taker, a speech-to-text feed or a CAD integration),
 * become triaged incidents with duplicates merged, and the copilot recommends which unit to send where, on the road
 * network as the gauges say it will be flooded. The dispatcher stays in charge: recommendations are only applied
 * when someone dispatches them.
 *
 * Time is in minutes since `epoch` (Unix ms), the same clock the gauge-driven flood model runs on.
 */

export type UnitStatus = 'available' | 'en_route' | 'on_scene' | 'out_of_service';

export interface LiveUnit {
  id: number;
  name: string;
  kind: UnitKind;
  vehicle: VehicleKind;
  station: number;
  node: number;
  status: UnitStatus;
  incident: number;
  since: number;
}

export interface LiveCall {
  t: number;
  text: string;
  phone?: string;
}

export interface LiveIncident extends OpenIncident {
  addressId: number | null;
  addressText: string | null;
  status: 'waiting' | 'assigned' | 'closed';
  unit: number;
  calls: LiveCall[];
  phones: string[];
  triage: Triage;
  /** Units that could not get through; the copilot will not recommend the same vehicle kind again. */
  blocked: VehicleKind[];
}

export interface CallInput {
  text: string;
  phone?: string;
  /** Caller location fix from the phone network, if any. */
  lat?: number;
  lon?: number;
  /** Uncertainty radius of the location fix (m). */
  accuracy?: number;
}

export interface Recommendation extends Pick {
  unitName: string;
  label: string;
  /** Route polyline from the unit to the incident. */
  route: number[] | null;
}

export interface Readiness {
  t: number;
  /** Road length closed to each vehicle (km). */
  closedKm: Record<VehicleKind, number>;
  totalKm: number;
  /** Address points with water at ankle (0.15 m), car-stalling (0.3 m) and chest (1.2 m) depth. */
  addresses: { ankle: number; stall: number; chest: number; total: number };
  /** Stations whose own streets are closed to their trucks. */
  stationsCutOff: string[];
  /** Streets where water reaches chest height soonest, for pre-positioning boats. */
  firstStreets: { street: string; at: number; count: number; x: number; y: number }[];
}

export class LiveCenter {
  readonly router: Router;
  readonly triager: Triager;
  readonly units: LiveUnit[];
  readonly incidents: LiveIncident[] = [];
  private cache = new Map<string, Float32Array>();
  private totalKm = 0;

  constructor(
    readonly city: City,
    readonly flood: FloodModel,
    readonly epoch: number,
    opts: { fleet?: UnitSpec[]; clock?: () => number; router?: Router; triager?: Triager } = {},
  ) {
    this.router = opts.router ?? new Router(city, flood);
    this.triager = opts.triager ?? new Triager(city);
    this.clock = opts.clock ?? Date.now;
    this.units = (opts.fleet ?? defaultFleet(city)).map((s, id) => ({ ...s, id, node: city.stations[s.station].node, status: 'available', incident: -1, since: 0 }));
    for (let e = 0; e < city.m; e++) this.totalKm += city.eLen[e] / 1000;
  }

  private clock: () => number;

  /** Minutes since the epoch. */
  now(): number {
    return (this.clock() - this.epoch) / 60000;
  }

  /** The flood model's curves changed (new gauge readings or a what-if): drop cached drive times. */
  floodChanged(): void {
    this.cache.clear();
  }

  timesTo(node: number, vehicle: VehicleKind, t: number): Float32Array {
    // roads open and close slowly; drive times are reused for five minutes of model time
    const key = `${node}|${vehicle}|${Math.floor(t / 5)}`;
    let v = this.cache.get(key);
    if (!v) {
      v = Float32Array.from(this.router.search(node, vehicle, t).time);
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(key, v);
    }
    return v;
  }

  /** Take a call: triage it, merge it into an open incident if it is a repeat, or open a new one. */
  call(input: CallInput): { incident: LiveIncident; merged: boolean; triage: Triage } {
    const now = this.now();
    const fix = input.lat !== undefined && input.lon !== undefined ? lonLatToXY(this.city, input.lon, input.lat) : null;
    const tr = this.triager.triage(input.text, fix?.[0], fix?.[1]);
    const open = this.incidents.filter((c) => c.status !== 'closed');
    const dup = findDuplicate(open, tr, { phone: input.phone, x: fix?.[0], y: fix?.[1], r: input.accuracy ?? 300 }, (c) => c.phones, now);
    const rec: LiveCall = { t: now, text: input.text, phone: input.phone };
    if (dup) {
      dup.calls.push(rec);
      if (input.phone && !dup.phones.includes(input.phone)) dup.phones.push(input.phone);
      escalate(dup, tr);
      if (dup.addressId === null && tr.address) Object.assign(dup, { addressId: tr.address.id, addressText: tr.addressText, x: tr.address.x, y: tr.address.y, node: tr.address.node });
      return { incident: dup, merged: true, triage: tr };
    }
    const where = tr.address ?? (fix ? { x: fix[0], y: fix[1], node: this.city.nearestNode(fix[0], fix[1]), id: -1 } : null);
    const inc: LiveIncident = {
      id: this.incidents.length,
      opened: now,
      type: tr.type,
      acuity: tr.acuity,
      x: where?.x ?? NaN,
      y: where?.y ?? NaN,
      node: where?.node ?? -1,
      people: tr.people,
      vuln: { ...tr.vuln },
      reportedDepth: tr.reportedDepth,
      addressId: tr.address ? tr.address.id : null,
      addressText: tr.addressText,
      status: CAN_SERVE[tr.type].length ? 'waiting' : 'closed',
      unit: -1,
      calls: [rec],
      phones: input.phone ? [input.phone] : [],
      triage: tr,
      blocked: [],
    };
    this.incidents.push(inc);
    return { incident: inc, merged: false, triage: tr };
  }

  /** Incidents with a location that still need a unit. */
  waiting(): LiveIncident[] {
    return this.incidents.filter((c) => c.status === 'waiting' && c.node >= 0);
  }

  /** The copilot's recommended assignments right now. Nothing is dispatched until a dispatcher accepts. */
  recommend(withRoutes = true): Recommendation[] {
    const now = this.now();
    const free = this.units.filter((u) => u.status === 'available');
    const picks = planAssignments(
      free.map((u) => ({ id: u.id, kind: u.kind, vehicle: u.vehicle, node: u.node })),
      this.waiting(),
      now,
      { flood: this.flood, timesTo: (n, v, t) => this.timesTo(n, v, t), blocked: (c, v) => this.incidents[c].blocked.includes(v) },
    );
    return picks
      .sort((a, b) => b.gain - a.gain)
      .map((p) => {
        const u = this.units[p.unit];
        const c = this.incidents[p.incident];
        let route: number[] | null = null;
        if (withRoutes) {
          const s = this.router.search(c.node, u.vehicle, now, p.minutes + 1);
          route = this.router.route(s, u.node)?.pts ?? null;
        }
        return { ...p, unitName: u.name, label: `${TYPE_LABEL[c.type]}${c.addressText ? ` at ${c.addressText}` : ''}`, route };
      });
  }

  dispatch(unitId: number, incidentId: number): void {
    const u = this.unit(unitId);
    const c = this.incident(incidentId);
    if (u.status !== 'available') throw new Error(`${u.name} is not available`);
    if (c.status !== 'waiting') throw new Error(`incident ${c.id} is not waiting for a unit`);
    Object.assign(u, { status: 'en_route', incident: c.id, since: this.now() });
    Object.assign(c, { status: 'assigned', unit: u.id });
  }

  /** A unit reports its status. Arriving puts it at the scene; clearing frees it there; turning back re-queues the incident. */
  setUnit(unitId: number, status: UnitStatus | 'turned_back'): void {
    const u = this.unit(unitId);
    const c = u.incident >= 0 ? this.incidents[u.incident] : null;
    const now = this.now();
    if (status === 'turned_back') {
      if (c) {
        if (!c.blocked.includes(u.vehicle)) c.blocked.push(u.vehicle);
        Object.assign(c, { status: 'waiting', unit: -1 });
      }
      Object.assign(u, { status: 'available', incident: -1, since: now });
      return;
    }
    if (status === 'on_scene' && c) u.node = c.node;
    if ((status === 'available' || status === 'out_of_service') && c) {
      if (u.status === 'on_scene') {
        u.node = c.node;
        c.status = 'closed';
      } else Object.assign(c, { status: 'waiting', unit: -1 });
      u.incident = -1;
    }
    Object.assign(u, { status, since: now });
  }

  close(incidentId: number): void {
    const c = this.incident(incidentId);
    if (c.unit >= 0 && this.units[c.unit].incident === c.id) Object.assign(this.units[c.unit], { status: 'available', incident: -1, since: this.now() });
    c.status = 'closed';
  }

  private unit(id: number): LiveUnit {
    const u = this.units[id];
    if (!u) throw new Error(`no unit ${id}`);
    return u;
  }

  private incident(id: number): LiveIncident {
    const c = this.incidents[id];
    if (!c) throw new Error(`no incident ${id}`);
    return c;
  }

  /** What the flood will have done by time t: closed roads, wet addresses, cut-off stations, and where to stage boats. */
  readiness(t: number, horizon = t): Readiness {
    const { city, flood } = this;
    const closedKm = { car: 0, highwater: 0, boat: 0 };
    for (let e = 0; e < city.m; e++) {
      const km = city.eLen[e] / 1000;
      if (!flood.passable(e, 'car', t)) closedKm.car += km;
      if (!flood.passable(e, 'highwater', t)) closedKm.highwater += km;
    }
    const addresses = { ankle: 0, stall: 0, chest: 0, total: city.addresses.length };
    const streets = new Map<string, { at: number; count: number; x: number; y: number }>();
    for (const a of city.addresses) {
      const d = flood.depthAt(a.x, a.y, t);
      if (d >= 0.15) addresses.ankle++;
      if (d >= DEPTH_LIMIT.car) addresses.stall++;
      if (d >= 1.2) addresses.chest++;
      const at = flood.timeToDepth(a.x, a.y, 1.2, this.now() - 1e-9);
      if (at <= horizon) {
        const s = streets.get(a.street);
        if (!s) streets.set(a.street, { at, count: 1, x: a.x, y: a.y });
        else {
          s.count++;
          if (at < s.at) Object.assign(s, { at, x: a.x, y: a.y });
        }
      }
    }
    const firstStreets = [...streets]
      .map(([street, s]) => ({ street, ...s }))
      .filter((s) => s.count >= 2)
      .sort((a, b) => a.at - b.at || b.count - a.count)
      .slice(0, 12);
    const stationsCutOff: string[] = [];
    for (const s of city.stations) {
      if (s.kind === 'hospital') continue;
      const vehicle: VehicleKind = s.kind === 'fire' ? 'highwater' : 'car';
      let open = false;
      for (let k = city.adjStart[s.node]; k < city.adjStart[s.node + 1]; k++) if (flood.passable(city.adjEdge[k], vehicle, t)) open = true;
      if (!open) stationsCutOff.push(s.name);
    }
    return { t, closedKm, totalKm: this.totalKm, addresses, stationsCutOff, firstStreets };
  }

  /** JSON-safe view of the board for the console and the HTTP API. */
  snapshot(): {
    now: number;
    epoch: number;
    units: LiveUnit[];
    incidents: Omit<LiveIncident, 'triage'>[];
  } {
    return {
      now: this.now(),
      epoch: this.epoch,
      units: this.units,
      incidents: this.incidents.map(({ triage: _t, ...c }) => c),
    };
  }
}
