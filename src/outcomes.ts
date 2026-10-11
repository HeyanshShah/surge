import type { IncidentType, Vulnerability } from './types';

/**
 * Risk model: the chance that a person in an incident is still alive when help arrives.
 * Used two ways: with ground truth to score outcomes, and by the copilot with its own triage estimates
 * to decide who to reach first. Rates are illustrative and chosen to be conservative; the point is the
 * shape (cardiac arrest decays in minutes, rising water is harmless until it is suddenly not).
 */
export interface RiskInput {
  type: IncidentType;
  vuln: Vulnerability;
  severity: number;
  /** Water depth (m) at the incident location at minute t. */
  depthAt: (t: number) => number;
}

/** Cardiac arrest: survival to discharge starts near 45% and falls about 10% per minute without care. */
const ARREST_P0 = 0.45;
const ARREST_DECAY = 0.1;

/** Baseline hazard per minute for incidents whose risk does not depend on water depth. */
const FLAT_HAZARD: Partial<Record<IncidentType, number>> = {
  breathing: 0.0025,
  chest_pain: 0.001,
  stroke: 0.0006,
  injury: 0.0003,
  fire: 0.006,
  gas_leak: 0.0004,
  crime: 0.0008,
  welfare: 0.0004,
  info: 0,
};

/** Hazard per minute for someone trapped in a flooded home, by water depth there. */
export function waterHazard(depth: number): number {
  if (depth < 0.6) return 0.00005;
  if (depth < 1.2) return 0.0004;
  if (depth < 1.8) return 0.0015;
  if (depth < 2.5) return 0.004;
  return 0.01;
}

export function vulnFactor(v: Vulnerability): number {
  let f = 1;
  if (v.elderly) f *= 2;
  if (v.infant) f *= 2;
  if (v.mobility) f *= 2.5;
  if (v.medical) f *= 1.5;
  return f;
}

/** Probability a person survives from the start of the incident (t0) until help arrives (t1). */
export function survival(r: RiskInput, t0: number, t1: number): number {
  if (t1 <= t0) t1 = t0;
  const dt = t1 - t0;
  const vf = vulnFactor(r.vuln);
  switch (r.type) {
    case 'cardiac_arrest':
      return ARREST_P0 * Math.exp(-ARREST_DECAY * r.severity * dt);
    case 'water_rescue':
    case 'vehicle_in_water': {
      // integrate the depth-dependent hazard over the wait
      const base = r.type === 'vehicle_in_water' ? 0.006 : 0;
      let h = 0;
      const step = 2;
      for (let t = t0; t < t1; t += step) {
        const span = Math.min(step, t1 - t);
        h += (base + waterHazard(r.depthAt(t + span / 2))) * vf * r.severity * span;
      }
      return Math.exp(-h);
    }
    case 'medical_dependency':
      // oxygen and dialysis patients are fine for a while, then decline once reserves run out
      return Math.exp(-Math.max(0, dt - 90) * 0.003 * vf * r.severity);
    default:
      return Math.exp(-(FLAT_HAZARD[r.type] ?? 0) * vf * r.severity * dt);
  }
}

/** Best possible survival (instant response), for "preventable deaths" accounting. */
export function survivalAtBest(r: RiskInput, t0: number): number {
  return survival(r, t0, t0);
}
