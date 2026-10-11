import type { Address, City } from './city';
import { INCIDENT_TYPES, type IncidentType, type Vulnerability } from './types';

/**
 * Turns a raw 911 transcript into a structured, explainable incident card:
 *   where   - a real street address resolved against the city's address points (fuzzy, digit-by-digit numbers, abbreviations)
 *   what    - incident type from a weighted phrase lexicon with negation handling
 *   who     - head count and vulnerability (infants, elderly, mobility limits, medical dependence)
 *   danger  - reported water depth, escalation on repeat calls
 * Everything it concludes is tied to the words that triggered it, so a dispatcher can check it at a glance.
 * Runs in well under a millisecond per call with no network and no model download.
 */
export interface Triage {
  type: IncidentType;
  /** Score margin of the winning type over the runner-up, squashed to [0, 1]. */
  confidence: number;
  address: Address | null;
  addressText: string | null;
  people: number;
  vuln: Vulnerability;
  /** Water depth implied by the caller's words (m), or null if they did not say. */
  reportedDepth: number | null;
  repeat: boolean;
  /** 1 (immediate threat to life) .. 5 (no emergency). */
  acuity: 1 | 2 | 3 | 4 | 5;
  evidence: Evidence[];
}

export interface Evidence {
  text: string;
  label: string;
  kind: 'type' | 'where' | 'who' | 'danger';
}

interface Rule {
  re: RegExp;
  w: number;
  /** Ignore the match when it is negated ("he is not bleeding"). */
  negatable?: boolean;
}

const R = (re: RegExp, w: number, negatable = true): Rule => ({ re, w, negatable });

const LEXICON: Record<IncidentType, Rule[]> = {
  water_rescue: [
    // asking to be rescued
    R(/\b(trapped|stuck)\b/, 2.5),
    R(/\bneed (a|the) boat\b|\bwhere is the boat\b/, 3),
    R(/\b(rescued?|rescue us)\b/, 2.5),
    R(/\b(attic|roof|ceiling)\b/, 3),
    // flood context, which a medical call from a flooded house also has
    R(/\bwater\b[^.]{0,30}\b(rising|coming in|coming up|keeps|inside|in the house|up to|deep|at (my|our|the))\b/, 1),
    R(/\b(can'?t|cannot) (get|lift|carry|move) (her|him|them|us)\b/, 2, false),
    R(/\bupstairs|second floor\b/, 1),
    R(/\bflood(ing|ed)?\b/, 0.5),
    R(/\bknee deep|waist deep|chest deep\b/, 1),
  ],
  vehicle_in_water: [R(/\b(car|truck|vehicle|suv)\b/, 1.5), R(/\b(stuck|trapped) in (my|the|our|his|her) (car|truck|vehicle|suv)\b/, 4), R(/\b(stalled|floating|swept|drove into)\b/, 3), R(/\bhigh water\b/, 1)],
  cardiac_arrest: [
    R(/\b(not|isn'?t|is not|stopped) breathing\b/, 5, false),
    R(/\bno pulse|can'?t find a pulse\b/, 5, false),
    R(/\bunresponsive|turning blue\b/, 4),
    R(/\bdoing cpr|\bcpr\b/, 4),
    R(/\bcollapsed\b/, 2.5),
  ],
  breathing: [R(/\b(can'?t|cannot|trouble|hard to) (breathe|breathing|catch (his|her|my) breath)\b/, 4, false), R(/\basthma|wheez\w*|inhaler\b/, 3), R(/\bshort of breath\b/, 3)],
  chest_pain: [R(/\bchest (pain|hurts|is tight|tight)\b|\bheart attack\b/, 4), R(/\barm hurts\b/, 1)],
  stroke: [R(/\bstroke\b/, 4), R(/\bslurr\w*|face (is )?droop\w*|drooping\b/, 4), R(/\bcan'?t (move|lift) (his|her|my) (left|right)? ?(arm|leg|side)\b/, 3, false), R(/\bcannot talk right|can'?t talk right\b/, 3, false)],
  medical_dependency: [
    R(/\boxygen\b[^.]{0,40}\b(running out|out|stopped|tank|machine|power)\b/, 4),
    R(/\b(missed|needs?) dialysis\b|\bdialysis\b/, 3.5),
    R(/\bventilator\b/, 4),
    R(/\binsulin\b/, 1.5),
  ],
  injury: [R(/\b(fell|fall|fallen)\b/, 2.5), R(/\bbroken|broke\b/, 2), R(/\bbleeding|blood\b/, 2.5), R(/\bcut (his|her|my)\b/, 2), R(/\bhit (his|her|my) head\b/, 2)],
  fire: [R(/\bon fire\b|\bfire\b/, 4), R(/\bsmoke\b/, 2.5), R(/\bflames?|burning|sparks\b/, 2.5)],
  gas_leak: [R(/\bsmell(s|ing)? (like )?gas\b|\bgas leak\b/, 5), R(/\brotten eggs\b/, 2)],
  crime: [
    R(/\bbreak(ing)? in(to)?\b|\bbreak into\b|\bbroke in\b/, 4),
    R(/\b(trying to|tried to) (get|break|come) in\b|\bintruder\b|\bsomeone (is )?in (my|the) house\b/, 4),
    R(/\b(smashed|broke|breaking) (the |a |my )?(window|door)\b/, 3),
    R(/\bloot\w*\b/, 4),
    R(/\bgun|shot|shooting|robb\w*|threatening|stabbed\b/, 4),
  ],
  welfare: [R(/\bcheck on\b/, 3.5), R(/\bcan'?t reach\b|\bhaven'?t heard from\b|\bnot answering|isn'?t answering\b/, 3, false)],
  info: [
    R(/\bshelter\b/, 2.5),
    R(/\bsandbags?\b/, 3),
    R(/\bwhen is it coming back\b|\bpower is out\b/, 1.5),
    R(/\bjust (want(ed)? to|letting you) (report|know)\b|\bjust letting you know\b/, 3),
    R(/\bwe'?re (fine|ok)\b|\bwe are (fine|ok)\b|\bare fine\b|\bok but\b/, 3),
    R(/\bis the (freeway|road|highway) open\b|\bis it safe\b/, 3),
  ],
};

const NEGATION = /\b(not|no|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|never|without)\s+(\w+\s+){0,2}$/;

const NUMBER_WORDS: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const ABBR: Record<string, string> = {
  st: 'street',
  dr: 'drive',
  ave: 'avenue',
  av: 'avenue',
  blvd: 'boulevard',
  ln: 'lane',
  rd: 'road',
  ct: 'court',
  cir: 'circle',
  pl: 'place',
  pkwy: 'parkway',
  trl: 'trail',
  fwy: 'freeway',
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
};
/** Everyday words that sit one typo away from a street name (please/Pease, water/Waters). */
const COMMON = new Set(['please', 'water', 'rising', 'hurry', 'there', 'their', 'house', 'mother', 'father', 'number', 'address', 'little', 'street', 'outside', 'inside', 'people']);
const GENERIC = new Set(['street', 'drive', 'avenue', 'boulevard', 'lane', 'road', 'court', 'circle', 'place', 'parkway', 'trail', 'way', 'freeway', 'north', 'south', 'east', 'west', 'the', 'of']);

export class Triager {
  private byNumber = new Map<number, { addr: Address; core: string[] }[]>();
  /** Street name (core words) -> its known address points, sorted by house number, for interpolation. */
  private byStreet = new Map<string, Address[]>();

  constructor(readonly city: City) {
    for (const a of city.addresses) {
      const core = tokens(a.street).filter((t) => !GENERIC.has(t));
      if (core.length === 0) continue;
      let list = this.byNumber.get(a.number);
      if (!list) this.byNumber.set(a.number, (list = []));
      list.push({ addr: a, core });
      const key = core.join(' ');
      let st = this.byStreet.get(key);
      if (!st) this.byStreet.set(key, (st = []));
      st.push(a);
    }
    for (const st of this.byStreet.values()) st.sort((a, b) => a.number - b.number);
  }

  /**
   * Classic range interpolation for a house number we have no point for: place it between the nearest
   * known numbers on the same street (same side of the street when possible).
   */
  private interpolate(core: string[], num: number): Address | null {
    const st = this.byStreet.get(core.join(' '));
    if (!st || st.length === 0) return null;
    const same = st.filter((a) => a.number % 2 === num % 2);
    const pts = same.length >= 2 ? same : st;
    let lo = pts[0];
    let hi = pts[pts.length - 1];
    for (const a of pts) {
      if (a.number <= num) lo = a;
      if (a.number >= num) {
        hi = a;
        break;
      }
    }
    if (Math.abs(lo.number - num) > 2000 && Math.abs(hi.number - num) > 2000) return null;
    const f = hi.number === lo.number ? 0 : (num - lo.number) / (hi.number - lo.number);
    const pick = f < 0.5 ? lo : hi;
    const street = lo.street;
    return { id: -1, x: lo.x + (hi.x - lo.x) * f, y: lo.y + (hi.y - lo.y) * f, number: num, street, node: pick.node };
  }

  triage(text: string, aliX?: number, aliY?: number): Triage {
    const evidence: Evidence[] = [];
    const lower = ' ' + text.toLowerCase().replace(/[’]/g, "'") + ' ';
    const spoken = collapseSpokenDigits(lower);

    // where: try every number in the text against the address points that carry it
    let address: Address | null = null;
    let addressText: string | null = null;
    let best = 0;
    // street words must sit next to the house number ("5423 braesvalley", "braesvalley, the number is 5423")
    const toks = tokens(spoken);
    toks.forEach((tok, i) => {
      if (!/^\d{2,6}$/.test(tok)) return;
      const cands = this.byNumber.get(+tok);
      if (!cands) return;
      const near = toks.slice(Math.max(0, i - 6), i + 7);
      for (const c of cands) {
        let hit = 0;
        for (const t of c.core) if (near.includes(t) || (t.length >= 5 && near.some((u) => u.length >= 4 && !COMMON.has(u) && editDistance(t, u) <= 1))) hit++;
        let score = hit / c.core.length;
        if (score < 0.99) continue;
        if (aliX !== undefined && aliY !== undefined) score += 0.001 / (1 + Math.hypot(c.addr.x - aliX, c.addr.y - aliY) / 1000);
        if (score > best) {
          best = score;
          address = c.addr;
          addressText = `${c.addr.number} ${c.addr.street}`;
        }
      }
    });
    let interpolated = false;
    if (!address) {
      // no exact address point: look for a known street name right next to a house number
      toks.forEach((tok, i) => {
        if (address || !/^\d{1,6}$/.test(tok)) return;
        for (let len = 3; len >= 1 && !address; len--) {
          for (const start of [i + 1, i - len]) {
            if (start < 0) continue;
            const words = toks.slice(start, start + len).filter((w) => !GENERIC.has(w));
            if (words.length === 0 || words.some((w) => /^\d+$/.test(w) && !/(st|nd|rd|th)$/.test(w))) continue;
            const a = this.interpolate(words, +tok);
            if (a) {
              address = a;
              addressText = `${a.number} ${a.street}`;
              interpolated = true;
              break;
            }
          }
        }
      });
    }
    if (address) evidence.push({ text: addressText!, label: interpolated ? 'address interpolated on street' : 'address matched', kind: 'where' });

    // strip the street name so "Hazard Street" or "Firethorn Drive" cannot vote for an incident type
    let body = spoken;
    if (address) for (const t of tokens(address.street)) if (!GENERIC.has(t)) body = body.replace(new RegExp(`\\b${escape(t)}\\b`, 'g'), ' ');

    // what
    const scores = new Map<IncidentType, number>();
    for (const type of INCIDENT_TYPES) {
      let s = 0;
      for (const rule of LEXICON[type]) {
        for (const m of body.matchAll(new RegExp(rule.re.source, 'g'))) {
          if (rule.negatable && NEGATION.test(body.slice(Math.max(0, m.index! - 30), m.index!))) continue;
          s += rule.w;
          evidence.push({ text: m[0].trim(), label: type, kind: 'type' });
          break;
        }
      }
      scores.set(type, s);
    }
    // a flooded home with a medical emergency inside is still a medical emergency first
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    let [type, top] = ranked[0];
    const second = ranked[1][1];
    if (top === 0) type = 'info';
    if (type === 'vehicle_in_water' && scores.get('water_rescue')! > 0 && !/\b(car|truck|vehicle|suv)\b/.test(body)) type = 'water_rescue';
    if (type === 'info' && scores.get('water_rescue')! >= 3 && !/\b(fine|ok)\b/.test(body)) type = 'water_rescue';
    const confidence = top === 0 ? 0.3 : 1 - Math.exp(-(top - second + 0.5) / 2.5);
    const typeEvidence = evidence.filter((e) => e.kind !== 'type' || e.label === type);

    // who
    const vuln: Vulnerability = { elderly: false, infant: false, mobility: false, medical: false };
    const who = (re: RegExp, key: keyof Vulnerability, label: string) => {
      const m = body.match(re);
      if (m) {
        vuln[key] = true;
        typeEvidence.push({ text: m[0].trim(), label, kind: 'who' });
      }
    };
    who(/\b(baby|newborn|infant|\d+ months? old|toddler)\b/, 'infant', 'infant');
    who(/\b(elderly|grandmother|grandfather|grandma|grandpa|(is|he'?s|she'?s|dad is|mother is|mom is) ([7-9]\d|1[01]\d)\b|([7-9]\d) years old)/, 'elderly', 'elderly');
    who(/\b(wheelchair|can'?t walk|cannot walk|bedridden|disabled|walker|can'?t (lift|carry|move) (her|him))\b/, 'mobility', 'cannot walk');
    who(/\b(oxygen|dialysis|pregnant|insulin|diabetic|ventilator)\b/, 'medical', 'medically dependent');
    const people = countPeople(body);
    if (people > 1) typeEvidence.push({ text: `${people} people`, label: 'head count', kind: 'who' });

    // danger
    let reportedDepth: number | null = null;
    for (const [re, d] of DEPTH_CUES) {
      const m = body.match(re);
      if (m && (reportedDepth === null || d > reportedDepth)) {
        reportedDepth = d;
        typeEvidence.push({ text: m[0].trim(), label: `~${d} m water`, kind: 'danger' });
      }
    }
    const repeatM = body.match(/\b(called \d+ minutes ago|already called|third time calling|been waiting|nobody came)\b/);
    if (repeatM) typeEvidence.push({ text: repeatM[0], label: 'repeat caller', kind: 'danger' });

    const acuity = acuityOf(type, vuln, reportedDepth);
    return { type, confidence, address, addressText, people, vuln, reportedDepth, repeat: !!repeatM, acuity, evidence: typeEvidence };
  }
}

const DEPTH_CUES: [RegExp, number][] = [
  [/\b(street is flooding|water is in the yard|rising outside)\b/, 0],
  [/\b(coming in the house|coming under the door|water inside|inside now|ankles?)\b/, 0.2],
  [/\b(knees?|knee deep)\b/, 0.5],
  [/\b(waist|waist deep)\b/, 1.0],
  [/\b(chest|chest deep)\b(?! pain| hurts| is tight)/, 1.4],
  [/\b(neck|attic|roof|ceiling)\b/, 2.0],
];

function acuityOf(type: IncidentType, v: Vulnerability, depth: number | null): Triage['acuity'] {
  const vulnerable = v.elderly || v.infant || v.mobility || v.medical;
  switch (type) {
    case 'cardiac_arrest':
    case 'vehicle_in_water':
      return 1;
    case 'fire':
      return 1;
    case 'water_rescue':
      if ((depth ?? 0) >= 1.4 || ((depth ?? 0) >= 0.9 && vulnerable)) return 1;
      return (depth ?? 0) >= 0.5 || vulnerable ? 2 : 3;
    case 'breathing':
    case 'stroke':
    case 'chest_pain':
      return 2;
    case 'medical_dependency':
      return vulnerable ? 2 : 3;
    case 'injury':
    case 'gas_leak':
    case 'crime':
      return 3;
    case 'welfare':
      return 4;
    default:
      return 5;
  }
}

function countPeople(s: string): number {
  const n = s.match(/\b(\d+|two|three|four|five|six|seven|eight|nine|ten) (of us|people|kids|children|adults)\b/);
  if (n) return Math.min(12, (NUMBER_WORDS[n[1]] ?? +n[1]) + (/kids|children/.test(n[2]) ? 1 : 0));
  if (/\bwe have (\d+|two|three|four|five|six)\b/.test(s)) {
    const k = s.match(/\bwe have (\d+|two|three|four|five|six)\b/)!;
    return NUMBER_WORDS[k[1]] ?? +k[1];
  }
  let c = /\b(we|us|our)\b/.test(s) ? 2 : 1;
  if (/\b(just me|by myself|alone)\b/.test(s)) c = 1;
  if (/\b(baby|newborn|daughter|son|kids)\b/.test(s) && c >= 2) c++;
  return c;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBR[t] ?? t);
}

/** "five four two three braesvalley" -> "5423 braesvalley": callers read house numbers digit by digit. */
function collapseSpokenDigits(s: string): string {
  return s.replace(/\b((?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)){2,})\b/g, (m) =>
    m
      .split(/[\s-]+/)
      .map((w) => NUMBER_WORDS[w])
      .join(''),
  );
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
