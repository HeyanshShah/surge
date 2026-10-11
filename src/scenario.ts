import type { City } from './city';
import type { FloodModel } from './flood';
import { Rng, deriveSeed } from './rng';
import { transcript } from './transcripts';
import type { Call, Incident, IncidentType, Vulnerability } from './types';

export interface ScenarioOptions {
  seed: number;
  /** Scenario length in minutes (default: the six worst hours, 22:00 to 04:00). */
  minutes?: number;
  /** Multiplies how many emergencies happen. 1 is calibrated to the Harvey surge on this slice of Houston. */
  intensity?: number;
  /** Call-takers answering 911 lines. */
  callTakers?: number;
}

export interface Scenario {
  seed: number;
  minutes: number;
  callTakers: number;
  incidents: Incident[];
  calls: Call[];
}

/** Non-flood emergencies per minute at the start of the night, and their mix. */
const BACKGROUND_RATE = 0.55;
const BACKGROUND_MIX: [IncidentType, number][] = [
  ['cardiac_arrest', 5],
  ['breathing', 11],
  ['chest_pain', 9],
  ['stroke', 5],
  ['medical_dependency', 9],
  ['injury', 12],
  ['fire', 5],
  ['gas_leak', 4],
  ['crime', 7],
  ['welfare', 9],
  ['info', 30],
];
/** Share of sampled address points whose home floods that end up calling for rescue during the night. */
const RESCUE_SHARE = 0.028;
const VEHICLE_SHARE = 0.009;

export function makeScenario(city: City, flood: FloodModel, opts: ScenarioOptions): Scenario {
  const minutes = opts.minutes ?? 360;
  const intensity = opts.intensity ?? 1;
  const rng = new Rng(deriveSeed(opts.seed, 1));
  const incidents: Incident[] = [];

  const add = (type: IncidentType, t0: number, addrId: number, people: number, vuln: Vulnerability) => {
    const a = city.addresses[addrId];
    incidents.push({ id: incidents.length, type, t0, address: addrId, x: a.x, y: a.y, node: a.node, people, vuln, severity: 0.7 + 0.6 * rng.next() });
  };

  // Flood emergencies happen where and when the water actually arrives.
  for (const a of city.addresses) {
    const wet = flood.timeToDepth(a.x, a.y, 0.4);
    if (!(wet < minutes)) continue;
    if (rng.chance(RESCUE_SHARE * intensity)) {
      const t0 = wet + rng.next() * 25;
      if (t0 < minutes) add('water_rescue', t0, a.id, household(rng), vulnerability(rng, 'water_rescue'));
    } else if (rng.chance(VEHICLE_SHARE * intensity)) {
      const t0 = Math.max(0, wet - 20 + rng.next() * 30);
      if (t0 < minutes) add('vehicle_in_water', t0, a.id, 1 + (rng.chance(0.4) ? 1 : 0), vulnerability(rng, 'vehicle_in_water'));
    }
  }

  // Everything else keeps happening too, a little more as the night goes on.
  const total = BACKGROUND_MIX.reduce((s, [, w]) => s + w, 0);
  for (let t = rng.next(); t < minutes; ) {
    const rate = BACKGROUND_RATE * intensity * (1 + (0.8 * t) / minutes);
    t += -Math.log(1 - rng.next()) / rate;
    if (t >= minutes) break;
    let r = rng.next() * total;
    let type: IncidentType = 'info';
    for (const [k, w] of BACKGROUND_MIX) {
      if ((r -= w) < 0) {
        type = k;
        break;
      }
    }
    add(type, t, rng.int(0, city.addresses.length), 1, vulnerability(rng, type));
  }
  incidents.sort((a, b) => a.t0 - b.t0);
  incidents.forEach((inc, i) => (inc.id = i));

  const calls = makeCalls(city, flood, incidents, minutes, new Rng(deriveSeed(opts.seed, 2)));
  return { seed: opts.seed, minutes, callTakers: opts.callTakers ?? 16, incidents, calls };
}

function household(rng: Rng): number {
  let n = 1;
  while (n < 7 && rng.chance(0.55)) n++;
  return n;
}

function vulnerability(rng: Rng, type: IncidentType): Vulnerability {
  const old = type === 'cardiac_arrest' || type === 'stroke' || type === 'chest_pain' || type === 'medical_dependency' ? 0.6 : 0.22;
  return {
    elderly: rng.chance(old),
    infant: type === 'water_rescue' && rng.chance(0.1),
    mobility: rng.chance(type === 'water_rescue' ? 0.1 : 0.05),
    medical: type === 'medical_dependency' || rng.chance(type === 'water_rescue' ? 0.08 : 0.03),
  };
}

function phone(rng: Rng): string {
  return `713-${String(rng.int(200, 999))}-${String(rng.int(1000, 9999))}`;
}

/**
 * Every call that would be placed if nobody ever came. The simulator drops a call if its incident has been
 * resolved before the phone rings, so a slow dispatcher really does get more repeat calls.
 */
function makeCalls(city: City, flood: FloodModel, incidents: Incident[], minutes: number, rng: Rng): Call[] {
  const calls: Call[] = [];
  for (const inc of incidents) {
    const urgent = inc.type === 'cardiac_arrest' || inc.type === 'fire' || inc.type === 'vehicle_in_water';
    const flood_ = inc.type === 'water_rescue' || inc.type === 'vehicle_in_water';
    const callers: { phone: string; thirdParty: boolean; first: number }[] = [];
    const thirdParty = inc.type === 'water_rescue' ? rng.chance(0.25) : inc.type === 'welfare' ? true : rng.chance(0.08);
    callers.push({ phone: phone(rng), thirdParty, first: inc.t0 + (urgent ? rng.next() * 2 : rng.next() * 8) });
    // neighbors and relatives reporting the same emergency
    const extra = inc.type === 'water_rescue' ? poisson(rng, 0.7) : inc.type === 'fire' ? poisson(rng, 1.2) : 0;
    for (let k = 0; k < extra; k++) callers.push({ phone: phone(rng), thirdParty: true, first: inc.t0 + 5 + rng.next() * 50 });

    for (const c of callers) {
      let t = c.first;
      for (let attempt = 1; t < minutes && attempt <= (flood_ ? 6 : 3); attempt++) {
        const a = city.addresses[inc.address];
        const ali = c.thirdParty ? farAway(rng, city) : near(rng, a.x, a.y);
        calls.push({
          id: 0,
          incident: inc.id,
          t,
          phone: c.phone,
          aliX: ali[0],
          aliY: ali[1],
          aliR: ali[2],
          ...said(transcript(rng, { inc, addr: a, depth: flood.depthAt(a.x, a.y, t), attempt, thirdParty: c.thirdParty, minutesWaiting: t - c.first })),
          patience: 2 + -Math.log(1 - rng.next()) * (urgent ? 10 : 6),
          attempt,
          thirdParty: c.thirdParty,
        });
        if (inc.type === 'info') break;
        t += (flood_ ? 25 : 35) + rng.next() * 25;
      }
    }
  }
  calls.sort((a, b) => a.t - b.t);
  calls.forEach((c, i) => (c.id = i));
  return calls;
}

function said(s: { text: string; addressGiven: boolean }) {
  return { transcript: s.text, addressGiven: s.addressGiven };
}

function poisson(rng: Rng, mean: number): number {
  let k = 0;
  let p = Math.exp(-mean);
  let s = p;
  const u = rng.next();
  while (u > s) {
    k++;
    p *= mean / k;
    s += p;
  }
  return k;
}

/** Wireless caller location: usually within 50-300 m of the true spot. */
function near(rng: Rng, x: number, y: number): [number, number, number] {
  const r = 50 + rng.next() * 250;
  const a = rng.next() * Math.PI * 2;
  const d = r * Math.sqrt(rng.next());
  return [x + Math.cos(a) * d, y + Math.sin(a) * d, r];
}

/** A relative calling from somewhere else entirely, so the phone's location says nothing about the emergency. */
function farAway(rng: Rng, city: City): [number, number, number] {
  const [x0, y0, x1, y1] = city.bounds;
  return [x0 + rng.next() * (x1 - x0), y0 + rng.next() * (y1 - y0), 100 + rng.next() * 400];
}
