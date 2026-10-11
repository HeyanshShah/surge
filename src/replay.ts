import type { City } from './city';
import { cadPolicy, surgePolicy } from './dispatch';
import type { FloodModel } from './flood';
import { survival } from './outcomes';
import type { Router } from './routing';
import { makeScenario } from './scenario';
import { type Metrics, type Policy, Sim, defaultFleet, truthRisk } from './sim';
import type { Triage } from './triage';
import { CAN_SERVE, type IncidentType } from './types';

/**
 * Everything the web app needs to replay one storm under two policies side by side, in a compact,
 * JSON-friendly shape. Built once (at build time for the default storm, or in a worker for a new seed).
 */
export interface Replay {
  seed: number;
  minutes: number;
  calls: { t: number; text: string; incident: number }[];
  incidents: { type: IncidentType; t0: number; x: number; y: number; people: number }[];
  policies: PolicyReplay[];
}

export interface PolicyReplay {
  name: string;
  key: 'surge' | 'cad';
  metrics: Metrics;
  units: { kind: string; vehicle: string; name: string; home: [number, number]; legs: ReplayLeg[] }[];
  cads: ReplayCad[];
  /** Per call: [answered minute or -1, cad id or -1, merged 0/1]. */
  calls: [number, number, number][];
  /** Copilot triage per call (surge only), keyed by call index. */
  triage?: Record<number, CompactTriage>;
  resolvedAt: number[];
  survived: number[];
  series: Series;
}

export interface ReplayLeg {
  t0: number;
  t1: number;
  kind: 'drive' | 'scene' | 'transport' | 'turned_back';
  cad: number;
  pts?: number[];
  mins?: number[];
}

export interface ReplayCad {
  id: number;
  opened: number;
  type: IncidentType;
  acuity: number;
  x: number;
  y: number;
  people: number;
  unit: number;
  assignedAt: number;
  closedAt: number;
  outcome: string;
  calls: number[];
  truths: number[];
}

export interface CompactTriage {
  type: IncidentType;
  acuity: number;
  confidence: number;
  address: string | null;
  people: number;
  vuln: string[];
  depth: number | null;
  evidence: [string, string, string][];
}

export interface Series {
  t: number[];
  deaths: number[];
  reached: number[];
  waiting: number[];
  onHold: number[];
}

const SAMPLE = 5;

export function compactTriage(tr: Triage): CompactTriage {
  return {
    type: tr.type,
    acuity: tr.acuity,
    confidence: Math.round(tr.confidence * 100) / 100,
    address: tr.addressText,
    people: tr.people,
    vuln: Object.entries(tr.vuln)
      .filter(([, v]) => v)
      .map(([k]) => k),
    depth: tr.reportedDepth,
    evidence: tr.evidence.map((e) => [e.text, e.label, e.kind]),
  };
}

export function buildReplay(city: City, flood: FloodModel, router: Router, seed: number, onProgress?: (f: number) => void): Replay {
  const sc = makeScenario(city, flood, { seed });
  const fleet = defaultFleet(city);
  const runs: [Policy, 'cad' | 'surge'][] = [
    [cadPolicy(), 'cad'],
    [surgePolicy(city), 'surge'],
  ];
  const policies: PolicyReplay[] = [];
  runs.forEach(([policy, key], pi) => {
    const sim = new Sim(city, flood, sc, policy, fleet, router);
    const waiting: number[] = [];
    const onHold: number[] = [];
    const ts: number[] = [];
    while (!sim.done) {
      if (Math.abs(sim.now % SAMPLE) < 1e-9) {
        ts.push(sim.now);
        waiting.push(sim.cads.filter((c) => c.status === 'waiting').length);
        onHold.push(sim.hold.length);
        onProgress?.((pi + sim.now / sc.minutes) / runs.length);
      }
      sim.step();
    }
    const metrics = sim.metrics();
    const deaths: number[] = [];
    const reached: number[] = [];
    for (const t of ts) {
      let d = 0;
      let r = 0;
      for (const inc of sc.incidents) {
        if (inc.t0 > t || CAN_SERVE[inc.type].length === 0 || !(sim.firstCall[inc.id] < Infinity)) continue;
        const end = Math.min(sim.resolvedAt[inc.id], t);
        d += inc.people * (1 - survival(truthRisk(inc, flood), inc.t0, end));
        if (sim.resolvedAt[inc.id] <= t) r += inc.people;
      }
      deaths.push(round(d, 2));
      reached.push(r);
    }
    const triage: Record<number, CompactTriage> = {};
    for (const cad of sim.cads) if (cad.triage) triage[cad.calls[0]] = compactTriage(cad.triage);
    policies.push({
      name: policy.name,
      key,
      metrics,
      units: sim.units.map((u) => ({
        kind: u.kind,
        vehicle: u.vehicle,
        name: u.name,
        home: [city.stations[u.station].x, city.stations[u.station].y],
        legs: u.legs.map((l) => ({
          t0: round(l.t0, 2),
          t1: round(l.t1, 2),
          kind: l.kind,
          cad: l.cad,
          ...(l.route ? { pts: l.route.pts.map((v) => Math.round(v)), mins: l.route.mins.map((v) => round(v, 2)) } : {}),
        })),
      })),
      cads: sim.cads.map((c) => ({
        id: c.id,
        opened: c.opened,
        type: c.type,
        acuity: c.acuity,
        x: Math.round(c.x),
        y: Math.round(c.y),
        people: c.people,
        unit: c.unit,
        assignedAt: c.assignedAt,
        closedAt: c.closedAt,
        outcome: c.outcome ?? '',
        calls: c.calls,
        truths: c.truths,
      })),
      calls: sim.calls.map((c) => [c.answered, c.cad, c.merged ? 1 : 0]),
      triage: key === 'surge' ? triage : undefined,
      resolvedAt: Array.from(sim.resolvedAt, (v) => (Number.isFinite(v) ? round(v, 2) : -1)),
      survived: Array.from(sim.survived, (v) => (Number.isNaN(v) ? -1 : round(v, 3))),
      series: { t: ts, deaths, reached, waiting, onHold },
    });
  });
  return {
    seed,
    minutes: sc.minutes,
    calls: sc.calls.map((c) => ({ t: round(c.t, 2), text: c.transcript, incident: c.incident })),
    incidents: sc.incidents.map((i) => ({ type: i.type, t0: round(i.t0, 2), x: i.x, y: i.y, people: i.people })),
    policies,
  };
}

function round(v: number, dp: number): number {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}
