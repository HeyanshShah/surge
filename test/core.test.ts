import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  City,
  FloodModel,
  Router,
  Sim,
  Triager,
  assignMax,
  cadPolicy,
  defaultFleet,
  makeScenario,
  survival,
  surgePolicy,
  type CityData,
} from '../src/index';
import { Rng } from '../src/rng';

let city: City;
let flood: FloodModel;
let router: Router;

beforeAll(() => {
  city = new City(JSON.parse(readFileSync(new URL('../data/houston.json', import.meta.url), 'utf8')) as CityData);
  flood = new FloodModel(city);
  router = new Router(city, flood);
});

describe('city model', () => {
  it('loads the real Houston graph, stations and addresses', () => {
    expect(city.n).toBeGreaterThan(20000);
    expect(city.stations.filter((s) => s.kind === 'fire').length).toBeGreaterThan(30);
    expect(city.stations.filter((s) => s.kind === 'hospital').length).toBeGreaterThan(10);
    expect(city.addresses.length).toBeGreaterThan(10000);
    expect(city.stations.some((s) => /Houston Fire Station \d+/.test(s.name))).toBe(true);
  });
});

describe('assignment', () => {
  it('matches brute force on random matrices, including forbidden pairs and unequal sizes', () => {
    const rng = new Rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const r = rng.int(1, 5);
      const c = rng.int(1, 5);
      const v = Array.from({ length: r }, () => Array.from({ length: c }, () => (rng.chance(0.2) ? -Infinity : Math.round(rng.next() * 100) / 10)));
      const got = assignMax(v);
      const score = (a: number[]) => a.reduce((s, j, i) => s + (j >= 0 ? v[i][j] : 0), 0);
      expect(new Set(got.filter((j) => j >= 0)).size).toBe(got.filter((j) => j >= 0).length);
      for (const [i, j] of got.entries()) if (j >= 0) expect(Number.isFinite(v[i][j])).toBe(true);
      expect(score(got)).toBeCloseTo(bruteForce(v), 6);
    }
  });
});

function bruteForce(v: number[][]): number {
  const cols = v[0].length;
  let best = 0;
  const rec = (i: number, used: Set<number>, acc: number) => {
    if (i === v.length) return void (best = Math.max(best, acc));
    rec(i + 1, used, acc);
    for (let j = 0; j < cols; j++) {
      if (used.has(j) || !Number.isFinite(v[i][j]) || v[i][j] < 0) continue;
      used.add(j);
      rec(i + 1, used, acc + v[i][j]);
      used.delete(j);
    }
  };
  rec(0, new Set(), 0);
  return best;
}

describe('flood model', () => {
  it('only deepens as the bayous rise', () => {
    for (let c = 0; c < city.elev.length; c += 997) {
      let prev = 0;
      for (let s = 0; s <= 6; s += 0.5) {
        const d = flood.depth(c, s);
        expect(d).toBeGreaterThanOrEqual(prev);
        prev = d;
      }
    }
  });

  it('puts water in the channels first and keeps high ground dry', () => {
    let channel = 0;
    let channelWet = 0;
    for (let c = 0; c < city.elev.length; c++) {
      if (!city.drain[c]) continue;
      channel++;
      if (flood.depth(c, 2) > 0.5) channelWet++;
    }
    expect(channelWet / channel).toBeGreaterThan(0.9);
    const highest = city.elev.indexOf(Math.max(...city.elev));
    expect(flood.depth(highest, 5)).toBe(0);
  });

  it('closes roads to cars before high-water trucks, and never to boats', () => {
    for (let e = 0; e < city.m; e += 101) expect(flood.edgeClose.car[e]).toBeLessThanOrEqual(flood.edgeClose.highwater[e]);
    expect(flood.edgeClose.boat.every((v) => v === Infinity)).toBe(true);
  });

  it('inverts the hydrograph', () => {
    for (const s of [1, 2.5, 4]) expect(flood.stage(flood.timeOfStage(s))).toBeCloseTo(s, 6);
  });
});

describe('routing', () => {
  it('is symmetric and agrees with the reconstructed route', () => {
    const a = city.stations[0].node;
    const b = city.stations[5].node;
    const sa = router.search(a, 'car', 0);
    const sb = router.search(b, 'car', 0);
    expect(sa.time[b]).toBeCloseTo(sb.time[a], 6);
    const r = router.route(sa, b)!;
    expect(r.total).toBeCloseTo(sa.time[b], 6);
  });

  it('loses reach for cars as the water rises, while boats reach everything', () => {
    const src = city.stations.find((s) => s.kind === 'fire')!.node;
    const reach = (k: 'car' | 'boat', t: number) => router.search(src, k, t).time.filter(Number.isFinite).length;
    expect(reach('car', 300)).toBeLessThan(reach('car', 0));
    expect(reach('boat', 300)).toBe(city.n);
  });
});

describe('triage', () => {
  // Written by hand in the way real callers talk, not produced by the scenario generator.
  const cases: [string, string, Partial<{ elderly: boolean; infant: boolean; mobility: boolean }>?][] = [
    ["my grandpa's not breathing!! he just fell over in the kitchen, i think he's dead, please", 'cardiac_arrest'],
    ['We are on the roof with our 2 kids and the dog, water keeps coming up, PLEASE send a boat', 'water_rescue', { infant: false }],
    ["she's 91 and bedridden and the water is at the mattress now, we can't lift her", 'water_rescue', { elderly: true, mobility: true }],
    ['my car died in the underpass on Kirby and the water is up to the windows, i cant open the door', 'vehicle_in_water'],
    ["there's smoke coming out of the garage next door and i see flames", 'fire'],
    ['hi um I just wanted to know which shelters are open tonight, we are ok', 'info'],
    ["my son is wheezing and his inhaler is empty, he can't breathe right", 'breathing'],
    ['someone smashed the window and is trying to get in the back door, i can hear them', 'crime'],
    ["my mom's on home oxygen and the power's been out for hours, the concentrator is off", 'medical_dependency'],
    ["it smells like gas real bad in the apartment and my head hurts", 'gas_leak'],
    ['my dad cannot lift his right arm and his speech is slurred, it started 10 minutes ago', 'stroke'],
    ['the baby is 3 months old and we are trapped upstairs, water rising on the stairs', 'water_rescue', { infant: true }],
  ];
  it.each(cases)('%s', (text, type, vuln) => {
    const r = new Triager(city).triage(text);
    expect(r.type).toBe(type);
    for (const [k, v] of Object.entries(vuln ?? {})) expect(r.vuln[k as 'elderly']).toBe(v);
  });

  it('resolves spoken and abbreviated addresses to real address points', () => {
    const tr = new Triager(city);
    const a = city.addresses[123];
    const words = a.street.split(' ');
    const spoken = String(a.number)
      .split('')
      .map((d) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][+d])
      .join(' ');
    const r = tr.triage(`please we are trapped at ${spoken} ${words.slice(0, -1).join(' ') || a.street} water is rising`);
    expect(r.address?.id).toBe(a.id);
  });

  it('does not let street names vote for incident types', () => {
    const tr = new Triager(city);
    const r = tr.triage("i'm fine just letting you know the street is flooded on Firethorn and Hazard");
    expect(r.type).toBe('info');
  });

  it('honors negation', () => {
    const tr = new Triager(city);
    expect(tr.triage('he fell down the stairs, he is not bleeding but cannot get up').type).toBe('injury');
    expect(tr.triage('there is no fire but i smell gas in the kitchen').type).toBe('gas_leak');
  });
});

describe('risk model', () => {
  it('never improves with waiting', () => {
    const vuln = { elderly: true, infant: false, mobility: false, medical: false };
    for (const type of ['cardiac_arrest', 'water_rescue', 'breathing', 'medical_dependency'] as const) {
      let prev = 1;
      for (let t = 0; t <= 240; t += 10) {
        const s = survival({ type, vuln, severity: 1, depthAt: (m) => m / 100 }, 0, t);
        expect(s).toBeLessThanOrEqual(prev + 1e-12);
        prev = s;
      }
    }
  });
});

describe('simulation', () => {
  it('is deterministic for a seed', () => {
    const sc = makeScenario(city, flood, { seed: 9, minutes: 90 });
    const run = () => new Sim(city, flood, sc, cadPolicy(), defaultFleet(city), router).run();
    expect(run()).toEqual(run());
  });

  it('the copilot saves more lives than standard CAD on a held-out storm', () => {
    const sc = makeScenario(city, flood, { seed: 4242 });
    const fleet = defaultFleet(city);
    const base = new Sim(city, flood, sc, cadPolicy(), fleet, router).run();
    const surge = new Sim(city, flood, sc, surgePolicy(city), fleet, router).run();
    expect(surge.deaths).toBeLessThan(base.deaths);
    expect(surge.turnedBack).toBeLessThan(base.turnedBack);
  }, 60_000);
});
