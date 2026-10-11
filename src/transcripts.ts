import type { Rng } from './rng';
import type { Address } from './city';
import type { Incident, IncidentType } from './types';

/**
 * Generates what a caller actually says: panicked, partial, out of order, sometimes without an address,
 * sometimes about someone else across town. The triage engine never sees which template produced a call.
 */
export interface CallContext {
  inc: Incident;
  addr: Address;
  depth: number;
  attempt: number;
  thirdParty: boolean;
  minutesWaiting: number;
}

const OPENERS = ['please help', 'hi yes', 'oh my god please', 'hello?', 'i need help', 'yes hi', 'please send someone', '', 'ok so', 'help us'];
const CLOSERS = ['please hurry', 'please', 'how long will it take', 'we need help now', 'oh god', 'please send somebody', '', '', 'thank you'];

const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const SUFFIX: Record<string, string> = {
  Street: 'st',
  Drive: 'dr',
  Avenue: 'ave',
  Boulevard: 'blvd',
  Lane: 'ln',
  Road: 'rd',
  Court: 'ct',
  Circle: 'cir',
  Place: 'pl',
  Parkway: 'pkwy',
  Way: 'way',
  Trail: 'trl',
};

export function addressPhrase(rng: Rng, a: Address): string | null {
  const words = a.street.split(' ');
  const last = words[words.length - 1];
  const bare = SUFFIX[last] ? words.slice(0, -1).join(' ') : a.street;
  const abbr = SUFFIX[last] ? `${bare} ${SUFFIX[last]}` : a.street;
  const r = rng.next();
  if (r < 0.1) return null;
  if (r < 0.4) return `${a.number} ${a.street}`;
  if (r < 0.6) return `${a.number} ${bare}`;
  if (r < 0.75) return `${a.number} ${abbr}`;
  if (r < 0.88) return `${bare}, the number is ${a.number}`;
  // house number read digit by digit, the way people do on the phone
  return `${String(a.number)
    .split('')
    .map((d) => NUM[+d])
    .join(' ')} ${bare}`;
}

function peoplePhrase(rng: Rng, inc: Incident): string {
  const n = inc.people;
  const v = inc.vuln;
  const parts: string[] = [];
  if (n === 1) parts.push(rng.pick(['it is just me', "i'm by myself", "i'm alone here"]));
  else if (n === 2) parts.push(rng.pick(['me and my wife', 'me and my husband', 'my mom and me', 'two of us']));
  else parts.push(rng.pick([`there are ${n} of us`, `${n} people here`, `we have ${n} people`, `${NUM[n] ?? n} of us`]));
  if (v.infant) parts.push(rng.pick(['i have a baby', 'my baby is with me', 'we have a newborn', 'my daughter is 4 months old']));
  if (v.elderly) parts.push(rng.pick(['my dad is 84', 'my grandmother is with us', "she's elderly", 'my mother is 79 years old']));
  if (v.mobility) parts.push(rng.pick(["he's in a wheelchair", "she can't walk", 'my husband is bedridden', 'my son is disabled']));
  if (v.medical) parts.push(rng.pick(['she is on oxygen', 'he needs dialysis', "i'm pregnant", 'he is diabetic and needs insulin']));
  return parts.join(', ');
}

export function depthPhrase(rng: Rng, depth: number): string {
  if (depth < 0.1) return rng.pick(['the street is flooding', 'water is in the yard', 'the water keeps rising outside']);
  if (depth < 0.35) return rng.pick(['water is coming in the house', 'water is coming under the door', 'there is water inside now', 'water is up to my ankles']);
  if (depth < 0.8) return rng.pick(['water is up to our knees', 'the water is knee deep in the house', 'water is at my knees and rising']);
  if (depth < 1.2) return rng.pick(['water is up to our waist', 'water is waist deep', 'the water is at my waist']);
  if (depth < 1.7) return rng.pick(['water is up to my chest', "it's chest deep in here", 'the water is at our chest']);
  return rng.pick(["we're in the attic", 'we had to go up in the attic', "we're on the roof", 'we are on the roof now', 'water is almost to the ceiling']);
}

const TYPE_TEXT: Record<Exclude<IncidentType, 'water_rescue' | 'info'>, string[]> = {
  vehicle_in_water: [
    'my car stalled in the water and it is rising',
    "we drove into high water and the car is floating",
    'our car got swept off the road into the water',
    "i'm stuck in my truck, water is coming in the doors",
  ],
  cardiac_arrest: [
    "my husband collapsed and he's not breathing",
    "my dad isn't breathing, i can't find a pulse",
    'she just collapsed, she is unresponsive and turning blue',
    "he's not breathing, i'm doing cpr",
  ],
  breathing: [
    "my son is having an asthma attack and can't breathe",
    'my mother is having trouble breathing',
    "he can't catch his breath, he's wheezing really bad",
    "i can't breathe, my inhaler isn't working",
  ],
  chest_pain: [
    'my husband has really bad chest pain',
    "i think i'm having a heart attack, my chest hurts",
    'my dad says his chest is tight and his arm hurts',
  ],
  stroke: [
    "my mom's face is drooping and she's slurring her words",
    "i think my husband is having a stroke, he can't move his left arm",
    'she suddenly cannot talk right and her face is drooping',
  ],
  medical_dependency: [
    'my mother is on oxygen and the power is out, her tank is running out',
    'my husband missed dialysis and is getting weak',
    "the power went out and my dad's oxygen machine stopped",
    "she's on a ventilator and the battery is almost dead",
  ],
  injury: [
    'my wife fell and hit her head, she is bleeding',
    'i fell and i think my leg is broken',
    'he cut his hand really bad on glass, lots of bleeding',
  ],
  fire: [
    "there's a fire in the kitchen, smoke everywhere",
    'the house next door is on fire',
    'there are sparks and smoke coming from the breaker box, something is burning',
  ],
  gas_leak: ['i smell gas really strong in the house', 'there is a gas leak, it smells like rotten eggs', 'we smell gas outside near the meter'],
  crime: [
    'someone is trying to break into my house',
    'people are looting the store across the street',
    'a man has a gun and is threatening people',
  ],
  welfare: [
    "i can't reach my grandmother, she lives alone and isn't answering",
    "i haven't heard from my dad since the storm started, can someone check on him",
    'please check on my elderly neighbor, her lights are off and she is not answering',
  ],
};

const INFO_TEXT = [
  'where is the nearest shelter',
  'is the freeway open, can i drive to my sister house',
  'the power is out on our street, when is it coming back',
  "i just want to report the street is flooded, we're fine",
  'how do i get sandbags',
  "is it safe to leave, we're ok but worried",
  'my street is flooded but we are on the second floor and fine, just letting you know',
];

export function transcript(rng: Rng, c: CallContext): { text: string; addressGiven: boolean } {
  const where = addressPhrase(rng, c.addr);
  return { text: say(rng, c, where), addressGiven: where !== null };
}

function say(rng: Rng, c: CallContext, where: string | null): string {
  const { inc } = c;
  const parts: string[] = [rng.pick(OPENERS)];
  if (c.attempt > 1) {
    const mins = Math.max(20, Math.round(c.minutesWaiting / 10) * 10);
    const flooded = inc.type === 'water_rescue' || inc.type === 'vehicle_in_water';
    parts.push(rng.pick([`i called ${mins} minutes ago and nobody came`, 'this is my third time calling', flooded ? 'i already called, where is the boat' : 'i already called, where is the ambulance', `we've been waiting for ${mins} minutes`]));
  }
  if (inc.type === 'info') {
    parts.push(rng.pick(INFO_TEXT));
    if (where && rng.chance(0.5)) parts.push(`i'm at ${where}`);
    return finish(rng, parts);
  }
  if (inc.type === 'water_rescue') {
    if (c.thirdParty) {
      parts.push(
        rng.pick([
          `my mother lives at ${where ?? 'her house'} and she is trapped, the water is rising`,
          `my neighbors at ${where ?? 'next door'} are trapped and need a boat`,
          `my family is stuck at ${where ?? 'their house'}, they texted me`,
        ]),
      );
      parts.push(depthPhrase(rng, c.depth));
    } else {
      parts.push(rng.pick(["we're trapped in our house", 'we need a boat', 'we are stuck, the water is rising fast', 'we need to be rescued']));
      parts.push(depthPhrase(rng, c.depth));
      if (where) parts.push(rng.pick([`we are at ${where}`, `the address is ${where}`, `${where}`, `i'm at ${where}`]));
      else parts.push(rng.pick(["i don't know the address", "i don't know the exact address, we just moved here"]));
    }
    parts.push(peoplePhrase(rng, inc));
    return finish(rng, parts);
  }
  const lines = TYPE_TEXT[inc.type];
  parts.push(rng.pick(lines));
  if (inc.type === 'vehicle_in_water') parts.push(rng.pick(['water is up to the windows', 'water is coming in fast', "the car won't start"]));
  else if (c.depth > 0.3 && rng.chance(0.6)) parts.push(depthPhrase(rng, c.depth));
  if (inc.vuln.elderly && rng.chance(0.6)) parts.push(rng.pick(['he is 81', 'she is 77 years old', 'she is elderly']));
  if (where) parts.push(rng.pick([`we are at ${where}`, `the address is ${where}`, `${where}`, `${c.thirdParty ? 'they are at' : "i'm at"} ${where}`]));
  else parts.push("i don't know the address");
  return finish(rng, parts);
}

function finish(rng: Rng, parts: string[]): string {
  parts.push(rng.pick(CLOSERS));
  let s = parts.filter(Boolean).join(rng.chance(0.4) ? ' ' : '. ');
  // speech-to-text noise: no capitals, sometimes no punctuation, filler words
  if (rng.chance(0.5)) s = s.replace(/[.,?]/g, '');
  if (rng.chance(0.3)) s = s.replace(/ (the|is) /, ' uh $1 ');
  if (rng.chance(0.5)) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}
