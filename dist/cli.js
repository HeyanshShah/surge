#!/usr/bin/env node

// src/cli.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/city.ts
var City = class {
  name;
  bounds;
  n;
  m;
  nx;
  ny;
  eA;
  eB;
  eLen;
  eCls;
  /** 1 = bridge, 2 = tunnel/underpass. */
  eFlags;
  eName;
  eShape;
  shapes;
  /** CSR adjacency: the edges touching node v are adjEdge[adjStart[v] .. adjStart[v+1]). */
  adjStart;
  adjEdge;
  streetNames;
  roadClasses;
  stations;
  addresses;
  grid;
  elev;
  drain;
  water;
  origin;
  scale;
  sources;
  constructor(d) {
    this.name = d.name;
    this.bounds = d.bounds;
    this.origin = d.origin;
    this.scale = d.scale;
    this.sources = d.sources;
    this.roadClasses = d.roadClasses;
    this.streetNames = d.streetNames;
    this.water = d.water;
    this.n = d.nodes.length / 2;
    this.m = d.edges.length / 6;
    this.nx = new Float64Array(this.n);
    this.ny = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.nx[i] = d.nodes[2 * i];
      this.ny[i] = d.nodes[2 * i + 1];
    }
    this.eA = new Int32Array(this.m);
    this.eB = new Int32Array(this.m);
    this.eLen = new Float32Array(this.m);
    this.eCls = new Uint8Array(this.m);
    this.eFlags = new Uint8Array(this.m);
    this.eName = new Int32Array(this.m);
    this.eShape = new Int32Array(this.m + 1);
    for (let e = 0; e < this.m; e++) {
      const o = 6 * e;
      this.eA[e] = d.edges[o];
      this.eB[e] = d.edges[o + 1];
      this.eLen[e] = d.edges[o + 2];
      this.eCls[e] = d.edges[o + 3] & 15;
      this.eFlags[e] = d.edges[o + 3] >> 4;
      this.eName[e] = d.edges[o + 4];
      this.eShape[e] = d.edges[o + 5];
    }
    this.eShape[this.m] = d.shapes.length;
    this.shapes = Int32Array.from(d.shapes);
    const deg = new Int32Array(this.n + 1);
    for (let e = 0; e < this.m; e++) {
      deg[this.eA[e] + 1]++;
      deg[this.eB[e] + 1]++;
    }
    for (let i = 0; i < this.n; i++) deg[i + 1] += deg[i];
    this.adjStart = deg.slice();
    this.adjEdge = new Int32Array(2 * this.m);
    const fill = deg.slice();
    for (let e = 0; e < this.m; e++) {
      this.adjEdge[fill[this.eA[e]]++] = e;
      this.adjEdge[fill[this.eB[e]]++] = e;
    }
    this.stations = d.stations.map((s, id) => ({ id, ...s }));
    this.addresses = [];
    for (let i = 0; i < d.addresses.length; i += 5) {
      const a = d.addresses;
      this.addresses.push({ id: i / 5, x: a[i], y: a[i + 1], number: a[i + 2], street: d.addrStreets[a[i + 3]], node: a[i + 4] });
    }
    const { elevDm, drain, ...g } = d.grid;
    this.grid = g;
    const raw = new Int16Array(bytes(elevDm).buffer);
    this.elev = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.elev[i] = raw[i] / 10;
    this.drain = bytes(drain);
  }
  other(e, v) {
    return this.eA[e] === v ? this.eB[e] : this.eA[e];
  }
  /** Polyline of edge e from endpoint `from` to the other end, as flat [x0, y0, x1, y1, ...]. */
  edgePoints(e, from = this.eA[e]) {
    const pts = [this.nx[this.eA[e]], this.ny[this.eA[e]]];
    for (let i = this.eShape[e]; i < this.eShape[e + 1]; i++) pts.push(this.shapes[i]);
    pts.push(this.nx[this.eB[e]], this.ny[this.eB[e]]);
    if (from === this.eA[e]) return pts;
    const rev = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
    return rev;
  }
  cellOf(x, y) {
    const { x0, y0, cell, w, h } = this.grid;
    const i = Math.min(w - 1, Math.max(0, Math.floor((x - x0) / cell)));
    const j = Math.min(h - 1, Math.max(0, Math.floor((y - y0) / cell)));
    return j * w + i;
  }
  /** Nearest road node by straight-line distance (linear scan; only used outside hot loops). */
  nearestNode(x, y) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = (this.nx[i] - x) ** 2 + (this.ny[i] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
  toLonLat(x, y) {
    return [x / this.scale[0] + this.origin[0], y / this.scale[1] + this.origin[1]];
  }
};
function bytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// src/hungarian.ts
function assignMax(value) {
  const rows = value.length;
  if (rows === 0) return [];
  const cols = value[0].length;
  const n = rows + cols;
  let maxV = 0;
  for (const r of value) for (const v2 of r) if (Number.isFinite(v2) && v2 > maxV) maxV = v2;
  const BIG = (maxV + 1) * 1e6;
  const cost = (i, j) => {
    if (i >= rows || j >= cols) return maxV;
    const v2 = value[i][j];
    return Number.isFinite(v2) ? maxV - v2 : BIG;
  };
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array(rows).fill(-1);
  for (let j = 1; j <= n; j++) {
    const i = p[j] - 1;
    if (i >= 0 && i < rows && j - 1 < cols && Number.isFinite(value[i][j - 1])) out[i] = j - 1;
  }
  return out;
}

// src/outcomes.ts
var ARREST_P0 = 0.45;
var ARREST_DECAY = 0.1;
var FLAT_HAZARD = {
  breathing: 25e-4,
  chest_pain: 1e-3,
  stroke: 6e-4,
  injury: 3e-4,
  fire: 6e-3,
  gas_leak: 4e-4,
  crime: 8e-4,
  welfare: 4e-4,
  info: 0
};
function waterHazard(depth) {
  if (depth < 0.6) return 5e-5;
  if (depth < 1.2) return 4e-4;
  if (depth < 1.8) return 15e-4;
  if (depth < 2.5) return 4e-3;
  return 0.01;
}
function vulnFactor(v) {
  let f = 1;
  if (v.elderly) f *= 2;
  if (v.infant) f *= 2;
  if (v.mobility) f *= 2.5;
  if (v.medical) f *= 1.5;
  return f;
}
function survival(r, t0, t1) {
  if (t1 <= t0) t1 = t0;
  const dt = t1 - t0;
  const vf = vulnFactor(r.vuln);
  switch (r.type) {
    case "cardiac_arrest":
      return ARREST_P0 * Math.exp(-ARREST_DECAY * r.severity * dt);
    case "water_rescue":
    case "vehicle_in_water": {
      const base = r.type === "vehicle_in_water" ? 6e-3 : 0;
      let h = 0;
      const step = 2;
      for (let t = t0; t < t1; t += step) {
        const span = Math.min(step, t1 - t);
        h += (base + waterHazard(r.depthAt(t + span / 2))) * vf * r.severity * span;
      }
      return Math.exp(-h);
    }
    case "medical_dependency":
      return Math.exp(-Math.max(0, dt - 90) * 3e-3 * vf * r.severity);
    default:
      return Math.exp(-(FLAT_HAZARD[r.type] ?? 0) * vf * r.severity * dt);
  }
}

// src/types.ts
var INCIDENT_TYPES = [
  "water_rescue",
  "vehicle_in_water",
  "cardiac_arrest",
  "breathing",
  "chest_pain",
  "stroke",
  "medical_dependency",
  "injury",
  "fire",
  "gas_leak",
  "crime",
  "welfare",
  "info"
];
var TYPE_LABEL = {
  water_rescue: "Trapped by floodwater",
  vehicle_in_water: "Vehicle in water",
  cardiac_arrest: "Cardiac arrest",
  breathing: "Breathing problem",
  chest_pain: "Chest pain",
  stroke: "Stroke",
  medical_dependency: "Life-support / dialysis",
  injury: "Injury",
  fire: "Fire",
  gas_leak: "Gas leak",
  crime: "Crime in progress",
  welfare: "Welfare check",
  info: "Non-emergency"
};
var CAN_SERVE = {
  water_rescue: ["rescue", "engine"],
  vehicle_in_water: ["rescue", "engine"],
  // fire engines carry EMTs and a defibrillator; a boat crew can reach a patient no ambulance can
  cardiac_arrest: ["medic", "engine", "rescue"],
  breathing: ["medic", "engine", "rescue"],
  chest_pain: ["medic", "engine", "rescue"],
  stroke: ["medic", "engine", "rescue"],
  medical_dependency: ["medic", "engine", "rescue"],
  injury: ["medic", "engine", "rescue"],
  fire: ["engine"],
  gas_leak: ["engine"],
  crime: ["police"],
  welfare: ["police", "engine"],
  info: []
};
var PROTOCOL_PRIORITY = {
  water_rescue: 1,
  vehicle_in_water: 1,
  cardiac_arrest: 1,
  fire: 1,
  breathing: 2,
  chest_pain: 2,
  stroke: 2,
  medical_dependency: 2,
  injury: 2,
  gas_leak: 2,
  crime: 2,
  welfare: 3,
  info: 3
};

// src/triage.ts
var R = (re, w, negatable = true) => ({ re, w, negatable });
var LEXICON = {
  water_rescue: [
    // asking to be rescued
    R(/\b(trapped|stuck)\b/, 2.5),
    R(/\bneed (a|the) boat\b|\bwhere is the boat\b/, 3),
    R(/\b(rescued?|rescue us)\b/, 2.5),
    R(/\b(attic|roof|ceiling)\b/, 3),
    // flood context, which a medical call from a flooded house also has
    R(/\bwater\b[^.]{0,30}\b(rising|coming in|inside|in the house|up to|deep|at (my|our))\b/, 1),
    R(/\bflood(ing|ed)?\b/, 0.5),
    R(/\bknee deep|waist deep|chest deep\b/, 1)
  ],
  vehicle_in_water: [R(/\b(car|truck|vehicle|suv)\b/, 1.5), R(/\b(stuck|trapped) in (my|the|our|his|her) (car|truck|vehicle|suv)\b/, 4), R(/\b(stalled|floating|swept|drove into)\b/, 3), R(/\bhigh water\b/, 1)],
  cardiac_arrest: [
    R(/\b(not|isn'?t|is not|stopped) breathing\b/, 5, false),
    R(/\bno pulse|can'?t find a pulse\b/, 5, false),
    R(/\bunresponsive|turning blue\b/, 4),
    R(/\bdoing cpr|\bcpr\b/, 4),
    R(/\bcollapsed\b/, 2.5)
  ],
  breathing: [R(/\b(can'?t|cannot|trouble|hard to) (breathe|breathing|catch (his|her|my) breath)\b/, 4, false), R(/\basthma|wheez\w*|inhaler\b/, 3), R(/\bshort of breath\b/, 3)],
  chest_pain: [R(/\bchest (pain|hurts|is tight|tight)\b|\bheart attack\b/, 4), R(/\barm hurts\b/, 1)],
  stroke: [R(/\bstroke\b/, 4), R(/\bslurr\w*|face (is )?droop\w*|drooping\b/, 4), R(/\bcan'?t (move|lift) (his|her|my) (left|right)? ?(arm|leg|side)\b/, 3, false), R(/\bcannot talk right|can'?t talk right\b/, 3, false)],
  medical_dependency: [
    R(/\boxygen\b[^.]{0,40}\b(running out|out|stopped|tank|machine|power)\b/, 4),
    R(/\b(missed|needs?) dialysis\b|\bdialysis\b/, 3.5),
    R(/\bventilator\b/, 4),
    R(/\binsulin\b/, 1.5)
  ],
  injury: [R(/\b(fell|fall|fallen)\b/, 2.5), R(/\bbroken|broke\b/, 2), R(/\bbleeding|blood\b/, 2.5), R(/\bcut (his|her|my)\b/, 2), R(/\bhit (his|her|my) head\b/, 2)],
  fire: [R(/\bon fire\b|\bfire\b/, 4), R(/\bsmoke\b/, 2.5), R(/\bflames?|burning|sparks\b/, 2.5)],
  gas_leak: [R(/\bsmell(s|ing)? (like )?gas\b|\bgas leak\b/, 5), R(/\brotten eggs\b/, 2)],
  crime: [R(/\bbreak(ing)? in(to)?\b|\bbreak into\b/, 4), R(/\bloot\w*\b/, 4), R(/\bgun|shot|shooting|robb\w*|threatening\b/, 4)],
  welfare: [R(/\bcheck on\b/, 3.5), R(/\bcan'?t reach\b|\bhaven'?t heard from\b|\bnot answering|isn'?t answering\b/, 3, false)],
  info: [
    R(/\bshelter\b/, 2.5),
    R(/\bsandbags?\b/, 3),
    R(/\bwhen is it coming back\b|\bpower is out\b/, 1.5),
    R(/\bjust (want(ed)? to|letting you) (report|know)\b|\bjust letting you know\b/, 3),
    R(/\bwe'?re (fine|ok)\b|\bwe are (fine|ok)\b|\bare fine\b|\bok but\b/, 3),
    R(/\bis the (freeway|road|highway) open\b|\bis it safe\b/, 3)
  ]
};
var NEGATION = /\b(not|no|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|never|without)\s+(\w+\s+){0,2}$/;
var NUMBER_WORDS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
var ABBR = {
  st: "street",
  dr: "drive",
  ave: "avenue",
  av: "avenue",
  blvd: "boulevard",
  ln: "lane",
  rd: "road",
  ct: "court",
  cir: "circle",
  pl: "place",
  pkwy: "parkway",
  trl: "trail",
  fwy: "freeway",
  n: "north",
  s: "south",
  e: "east",
  w: "west"
};
var COMMON = /* @__PURE__ */ new Set(["please", "water", "rising", "hurry", "there", "their", "house", "mother", "father", "number", "address", "little", "street", "outside", "inside", "people"]);
var GENERIC = /* @__PURE__ */ new Set(["street", "drive", "avenue", "boulevard", "lane", "road", "court", "circle", "place", "parkway", "trail", "way", "freeway", "north", "south", "east", "west", "the", "of"]);
var Triager = class {
  constructor(city) {
    this.city = city;
    for (const a of city.addresses) {
      const core = tokens(a.street).filter((t) => !GENERIC.has(t));
      if (core.length === 0) continue;
      let list = this.byNumber.get(a.number);
      if (!list) this.byNumber.set(a.number, list = []);
      list.push({ addr: a, core });
      const key = core.join(" ");
      let st = this.byStreet.get(key);
      if (!st) this.byStreet.set(key, st = []);
      st.push(a);
    }
    for (const st of this.byStreet.values()) st.sort((a, b) => a.number - b.number);
  }
  byNumber = /* @__PURE__ */ new Map();
  /** Street name (core words) -> its known address points, sorted by house number, for interpolation. */
  byStreet = /* @__PURE__ */ new Map();
  /**
   * Classic range interpolation for a house number we have no point for: place it between the nearest
   * known numbers on the same street (same side of the street when possible).
   */
  interpolate(core, num) {
    const st = this.byStreet.get(core.join(" "));
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
    if (Math.abs(lo.number - num) > 2e3 && Math.abs(hi.number - num) > 2e3) return null;
    const f = hi.number === lo.number ? 0 : (num - lo.number) / (hi.number - lo.number);
    const pick = f < 0.5 ? lo : hi;
    const street = lo.street;
    return { id: -1, x: lo.x + (hi.x - lo.x) * f, y: lo.y + (hi.y - lo.y) * f, number: num, street, node: pick.node };
  }
  triage(text, aliX, aliY) {
    const evidence = [];
    const lower = " " + text.toLowerCase().replace(/[’]/g, "'") + " ";
    const spoken = collapseSpokenDigits(lower);
    let address = null;
    let addressText = null;
    let best = 0;
    const toks = tokens(spoken);
    toks.forEach((tok, i) => {
      if (!/^\d{2,6}$/.test(tok)) return;
      const cands = this.byNumber.get(+tok);
      if (!cands) return;
      const near2 = toks.slice(Math.max(0, i - 6), i + 7);
      for (const c of cands) {
        let hit = 0;
        for (const t of c.core) if (near2.includes(t) || t.length >= 5 && near2.some((u) => u.length >= 4 && !COMMON.has(u) && editDistance(t, u) <= 1)) hit++;
        let score = hit / c.core.length;
        if (score < 0.99) continue;
        if (aliX !== void 0 && aliY !== void 0) score += 1e-3 / (1 + Math.hypot(c.addr.x - aliX, c.addr.y - aliY) / 1e3);
        if (score > best) {
          best = score;
          address = c.addr;
          addressText = `${c.addr.number} ${c.addr.street}`;
        }
      }
    });
    let interpolated = false;
    if (!address) {
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
    if (address) evidence.push({ text: addressText, label: interpolated ? "address interpolated on street" : "address matched", kind: "where" });
    let body = spoken;
    if (address) {
      for (const t of tokens(address.street)) if (!GENERIC.has(t)) body = body.replace(new RegExp(`\\b${escape(t)}\\b`, "g"), " ");
    }
    const scores = /* @__PURE__ */ new Map();
    for (const type2 of INCIDENT_TYPES) {
      let s = 0;
      for (const rule of LEXICON[type2]) {
        for (const m of body.matchAll(new RegExp(rule.re.source, "g"))) {
          if (rule.negatable && NEGATION.test(body.slice(Math.max(0, m.index - 30), m.index))) continue;
          s += rule.w;
          evidence.push({ text: m[0].trim(), label: type2, kind: "type" });
          break;
        }
      }
      scores.set(type2, s);
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    let [type, top] = ranked[0];
    const second = ranked[1][1];
    if (top === 0) type = "info";
    if (type === "vehicle_in_water" && scores.get("water_rescue") > 0 && !/\b(car|truck|vehicle|suv)\b/.test(body)) type = "water_rescue";
    if (type === "info" && scores.get("water_rescue") >= 3 && !/\b(fine|ok)\b/.test(body)) type = "water_rescue";
    const confidence = top === 0 ? 0.3 : 1 - Math.exp(-(top - second + 0.5) / 2.5);
    const typeEvidence = evidence.filter((e) => e.kind !== "type" || e.label === type);
    const vuln = { elderly: false, infant: false, mobility: false, medical: false };
    const who = (re, key, label) => {
      const m = body.match(re);
      if (m) {
        vuln[key] = true;
        typeEvidence.push({ text: m[0].trim(), label, kind: "who" });
      }
    };
    who(/\b(baby|newborn|infant|\d+ months? old|toddler)\b/, "infant", "infant");
    who(/\b(elderly|grandmother|grandfather|grandma|grandpa|(is|he'?s|she'?s|dad is|mother is|mom is) ([7-9]\d|1[01]\d)\b|([7-9]\d) years old)/, "elderly", "elderly");
    who(/\b(wheelchair|can'?t walk|cannot walk|bedridden|disabled|walker)\b/, "mobility", "cannot walk");
    who(/\b(oxygen|dialysis|pregnant|insulin|diabetic|ventilator)\b/, "medical", "medically dependent");
    const people = countPeople(body);
    if (people > 1) typeEvidence.push({ text: `${people} people`, label: "head count", kind: "who" });
    let reportedDepth = null;
    for (const [re, d] of DEPTH_CUES) {
      const m = body.match(re);
      if (m && (reportedDepth === null || d > reportedDepth)) {
        reportedDepth = d;
        typeEvidence.push({ text: m[0].trim(), label: `~${d} m water`, kind: "danger" });
      }
    }
    const repeatM = body.match(/\b(called \d+ minutes ago|already called|third time calling|been waiting|nobody came)\b/);
    if (repeatM) typeEvidence.push({ text: repeatM[0], label: "repeat caller", kind: "danger" });
    const acuity = acuityOf(type, vuln, reportedDepth);
    return { type, confidence, address, addressText, people, vuln, reportedDepth, repeat: !!repeatM, acuity, evidence: typeEvidence };
  }
};
var DEPTH_CUES = [
  [/\b(street is flooding|water is in the yard|rising outside)\b/, 0],
  [/\b(coming in the house|coming under the door|water inside|inside now|ankles?)\b/, 0.2],
  [/\b(knees?|knee deep)\b/, 0.5],
  [/\b(waist|waist deep)\b/, 1],
  [/\b(chest|chest deep)\b(?! pain| hurts| is tight)/, 1.4],
  [/\b(neck|attic|roof|ceiling)\b/, 2]
];
function acuityOf(type, v, depth) {
  const vulnerable = v.elderly || v.infant || v.mobility || v.medical;
  switch (type) {
    case "cardiac_arrest":
    case "vehicle_in_water":
      return 1;
    case "fire":
      return 1;
    case "water_rescue":
      if ((depth ?? 0) >= 1.4 || (depth ?? 0) >= 0.9 && vulnerable) return 1;
      return (depth ?? 0) >= 0.5 || vulnerable ? 2 : 3;
    case "breathing":
    case "stroke":
    case "chest_pain":
      return 2;
    case "medical_dependency":
      return vulnerable ? 2 : 3;
    case "injury":
    case "gas_leak":
    case "crime":
      return 3;
    case "welfare":
      return 4;
    default:
      return 5;
  }
}
function countPeople(s) {
  const n = s.match(/\b(\d+|two|three|four|five|six|seven|eight|nine|ten) (of us|people|kids|children|adults)\b/);
  if (n) return Math.min(12, (NUMBER_WORDS[n[1]] ?? +n[1]) + (/kids|children/.test(n[2]) ? 1 : 0));
  if (/\bwe have (\d+|two|three|four|five|six)\b/.test(s)) {
    const k = s.match(/\bwe have (\d+|two|three|four|five|six)\b/);
    return NUMBER_WORDS[k[1]] ?? +k[1];
  }
  let c = /\b(we|us|our)\b/.test(s) ? 2 : 1;
  if (/\b(just me|by myself|alone)\b/.test(s)) c = 1;
  if (/\b(baby|newborn|daughter|son|kids)\b/.test(s) && c >= 2) c++;
  return c;
}
function tokens(s) {
  return s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean).map((t) => ABBR[t] ?? t);
}
function collapseSpokenDigits(s) {
  return s.replace(
    /\b((?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)){2,})\b/g,
    (m) => m.split(/[\s-]+/).map((w) => NUMBER_WORDS[w]).join("")
  );
}
function editDistance(a, b) {
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
function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/dispatch.ts
var NO_VULN = { elderly: false, infant: false, mobility: false, medical: false };
function locate(sim, x, y) {
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
function humanIntake(call, now, sim) {
  const inc = sim.scenario.incidents[call.incident];
  const addr = call.addressGiven ? sim.city.addresses[inc.address] : null;
  const loc = addr ? { x: addr.x, y: addr.y, node: addr.node } : locate(sim, call.aliX, call.aliY);
  const dup = sim.openCads().find((c) => c.calls.some((k) => sim.scenario.calls[k].phone === call.phone) || addr && c.addressId === addr.id);
  if (dup) return sim.mergeCad(call, dup);
  sim.openCad(call, now, {
    type: inc.type,
    acuity: PROTOCOL_PRIORITY[inc.type],
    ...loc,
    addressId: addr ? addr.id : null,
    people: 1,
    vuln: NO_VULN,
    reportedDepth: null
  });
}
function closestUnitPolicy(name, order, byDriveTime = false) {
  return {
    name,
    intake: humanIntake,
    dispatch(now, sim) {
      const out = [];
      const idle = sim.idleUnits();
      if (!idle.length) return out;
      const taken = /* @__PURE__ */ new Set();
      const waiting = sim.cads.filter((c) => c.status === "waiting").sort(order);
      for (const cad of waiting) {
        let best = -1;
        let bd = Infinity;
        for (const u of idle) {
          if (taken.has(u.id) || !CAN_SERVE[cad.type].includes(u.kind) || cad.blocked.includes(u.vehicle)) continue;
          const d = byDriveTime ? sim.timesTo(cad.node, u.vehicle, now)[u.node] : Math.hypot(sim.city.nx[u.node] - cad.x, sim.city.ny[u.node] - cad.y);
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
    }
  };
}
var fifoPolicy = () => closestUnitPolicy("First come, first served", (a, b) => a.opened - b.opened);
var cadPolicy = () => closestUnitPolicy("Standard CAD", (a, b) => a.acuity - b.acuity || a.opened - b.opened);
var cadRoutedPolicy = () => closestUnitPolicy("CAD + flood routing", (a, b) => a.acuity - b.acuity || a.opened - b.opened, true);
var HORIZON = 120;
var TOP_K = 24;
var MAX_TRAVEL = 75;
var PREF = [1, 0.85, 0.85];
var UNIT_MINUTE = 0.01;
function surgePolicy(city, opts = {}) {
  const forecast = opts.forecast ?? true;
  const triager = new Triager(city);
  let lastRound = -Infinity;
  let dirty = true;
  const risk = (cad, sim) => ({
    type: cad.type,
    vuln: cad.vuln,
    severity: 1,
    depthAt: (t) => Math.max(cad.reportedDepth ?? 0, forecast ? sim.flood.depthAt(cad.x, cad.y, t) : 0)
  });
  const gain = (cad, sim, now, tt) => {
    const r = risk(cad, sim);
    const t0 = cad.opened - 4;
    const g = cad.people * (survival(r, t0, now + tt) - survival(r, t0, now + tt + HORIZON));
    return g + 4e-4 * cad.people * (now - cad.opened) + 1e-6 * (5 - cad.acuity);
  };
  return {
    name: opts.name ?? "Surge copilot",
    triager,
    intake(call, now, sim) {
      const tr = triager.triage(call.transcript, call.aliX, call.aliY);
      const loc = tr.address ? { x: tr.address.x, y: tr.address.y, node: tr.address.node } : locate(sim, call.aliX, call.aliY);
      dirty = true;
      const open = sim.openCads();
      const dup = open.find((c) => c.calls.some((k) => sim.scenario.calls[k].phone === call.phone)) ?? (tr.address ? open.find((c) => c.addressId === tr.address.id) : void 0) ?? (!tr.address && !call.thirdParty ? open.find((c) => c.type === tr.type && Math.hypot(c.x - call.aliX, c.y - call.aliY) < call.aliR + 100 && now - c.opened < 120) : void 0);
      if (dup) {
        sim.mergeCad(call, dup);
        if (tr.reportedDepth !== null) dup.reportedDepth = Math.max(dup.reportedDepth ?? 0, tr.reportedDepth);
        dup.people = Math.max(dup.people, tr.people);
        for (const k of Object.keys(dup.vuln)) dup.vuln[k] ||= tr.vuln[k];
        if (tr.acuity < dup.acuity && CAN_SERVE[tr.type].length) {
          dup.acuity = tr.acuity;
          if (dup.status === "waiting") dup.type = tr.type;
        }
        if (!dup.addressId && tr.address) Object.assign(dup, { addressId: tr.address.id, ...loc });
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
        triage: tr
      });
      cad.triage = tr;
    },
    dispatch(now, sim) {
      if (!dirty && now - lastRound < 3) return [];
      const idle = sim.idleUnits();
      const waiting = sim.cads.filter((c) => c.status === "waiting");
      if (!idle.length || !waiting.length) return [];
      dirty = false;
      lastRound = now;
      const scored = waiting.map((c) => ({ c, g: gain(c, sim, now, 0) })).sort((a, b) => b.g - a.g);
      const shortlist = /* @__PURE__ */ new Set();
      for (const kind of new Set(idle.map((u) => u.kind))) {
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
      const vehicles = [...new Set(idle.map((u) => u.vehicle))];
      const value = [];
      const units = idle.filter((u) => ranked.some((c) => CAN_SERVE[c.type].includes(u.kind)));
      const times = /* @__PURE__ */ new Map();
      for (const c of ranked) for (const v of vehicles) times.set(`${c.id}|${v}`, sim.timesTo(c.node, v, now));
      for (const u of units) {
        value.push(
          ranked.map((c) => {
            const pref = CAN_SERVE[c.type].indexOf(u.kind);
            if (pref < 0) return -Infinity;
            const tt = times.get(`${c.id}|${u.vehicle}`)[u.node];
            if (!Number.isFinite(tt) || tt > MAX_TRAVEL) return -Infinity;
            return gain(c, sim, now, tt) * PREF[pref] - tt * UNIT_MINUTE;
          })
        );
      }
      const pick = assignMax(value);
      const out = [];
      pick.forEach((j, i) => {
        if (j >= 0) out.push([units[i].id, ranked[j].id]);
      });
      if (out.length) dirty = true;
      return out;
    }
  };
}

// src/heap.ts
var NumHeap = class {
  keys = new Float64Array(1024);
  vals = new Int32Array(1024);
  size = 0;
  clear() {
    this.size = 0;
  }
  push(key, val) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      const v = new Int32Array(this.size * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    const keys = this.keys;
    const vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = i - 1 >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  /** Key of the minimum element. Only valid when size > 0. */
  topKey() {
    return this.keys[0];
  }
  /** Removes the minimum element and returns its value. Only valid when size > 0. */
  pop() {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    const k = keys[n];
    const v = vals[n];
    let i = 0;
    for (; ; ) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= k) break;
      keys[i] = keys[c];
      vals[i] = vals[c];
      i = c;
    }
    keys[i] = k;
    vals[i] = v;
    return top;
  }
};

// src/flood.ts
var FloodModel = class {
  constructor(city, hydrograph = HARVEY_STAGE) {
    this.city = city;
    this.stagePoints = hydrograph;
    const { w, h } = city.grid;
    const n = w * h;
    const elev = city.elev;
    this.src = new Float32Array(n);
    this.spill = new Float32Array(n).fill(Infinity);
    this.rise = new Float32Array(n);
    const heap = new NumHeap();
    for (let c = 0; c < n; c++) {
      if (city.drain[c]) {
        this.src[c] = elev[c];
        this.spill[c] = elev[c];
        this.rise[c] = city.drain[c] === 2 ? 1 : TRIBUTARY_RISE;
        heap.push(elev[c], c);
      }
    }
    const done = new Uint8Array(n);
    while (heap.size > 0) {
      const level = heap.topKey();
      const c = heap.pop();
      if (done[c]) continue;
      done[c] = 1;
      const i = c % w;
      const j = (c - i) / w;
      for (let k = 0; k < 4; k++) {
        const ni = i + DI[k];
        const nj = j + DJ[k];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nc = nj * w + ni;
        if (done[nc]) continue;
        const l = Math.max(level, elev[nc]);
        if (l < this.spill[nc]) {
          this.spill[nc] = l;
          this.src[nc] = this.src[c];
          this.rise[nc] = this.rise[c];
          heap.push(l, nc);
        }
      }
    }
    this.edgeClose = {
      car: new Float32Array(city.m),
      highwater: new Float32Array(city.m),
      boat: new Float32Array(city.m).fill(Infinity)
    };
    for (let e = 0; e < city.m; e++) {
      if (city.eFlags[e] & 1) {
        this.edgeClose.car[e] = Infinity;
        this.edgeClose.highwater[e] = Infinity;
        continue;
      }
      let car = Infinity;
      let hw = Infinity;
      const pts = city.edgePoints(e);
      for (let p = 0; p + 3 < pts.length; p += 2) {
        const len = Math.hypot(pts[p + 2] - pts[p], pts[p + 3] - pts[p + 1]);
        const steps = Math.max(1, Math.ceil(len / (city.grid.cell / 2)));
        for (let s = 0; s <= steps; s++) {
          const c = city.cellOf(pts[p] + (pts[p + 2] - pts[p]) * s / steps, pts[p + 1] + (pts[p + 3] - pts[p + 1]) * s / steps);
          car = Math.min(car, this.onset(c, DEPTH_LIMIT.car));
          hw = Math.min(hw, this.onset(c, DEPTH_LIMIT.highwater));
        }
      }
      if (city.eFlags[e] & 2) {
        car = Math.min(car, UNDERPASS_CLOSE.car);
        hw = Math.min(hw, UNDERPASS_CLOSE.highwater);
      }
      this.edgeClose.car[e] = car;
      this.edgeClose.highwater[e] = hw;
    }
  }
  src;
  spill;
  /** How much of the main-channel rise reaches the channel a cell drains to (tributaries rise less). */
  rise;
  stagePoints;
  /** Stage (m) at which each edge becomes impassable, per vehicle threshold. */
  edgeClose;
  /** Channel stage (m above bed) at time t (minutes into the scenario). */
  stage(t) {
    const p = this.stagePoints;
    if (t <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (t <= p[i][0]) {
        const [t0, s0] = p[i - 1];
        const [t1, s1] = p[i];
        return s0 + (s1 - s0) * (t - t0) / (t1 - t0);
      }
    }
    return p[p.length - 1][1];
  }
  /** First time the stage reaches s, or Infinity if it never does. */
  timeOfStage(s) {
    const p = this.stagePoints;
    if (s <= p[0][1]) return p[0][0];
    for (let i = 1; i < p.length; i++) {
      const [t0, s0] = p[i - 1];
      const [t1, s1] = p[i];
      if (s1 >= s && s0 < s) return t0 + (s - s0) * (t1 - t0) / (s1 - s0);
    }
    return Infinity;
  }
  /** Lowest stage at which cell c has at least `depth` meters of water. */
  onset(c, depth) {
    return Math.max(this.spill[c] - this.src[c], this.city.elev[c] + depth - this.src[c]) / this.rise[c];
  }
  depth(c, stage) {
    const top = this.src[c] + stage * this.rise[c];
    return top >= this.spill[c] ? Math.max(0, top - this.city.elev[c]) : 0;
  }
  depthAt(x, y, t) {
    return this.depth(this.city.cellOf(x, y), this.stage(t));
  }
  /** When water at (x, y) first reaches `depth` meters (minutes), or Infinity. */
  timeToDepth(x, y, depth) {
    return this.timeOfStage(this.onset(this.city.cellOf(x, y), depth));
  }
  passable(e, kind, t) {
    return this.stage(t) < this.edgeClose[kind][e];
  }
};
var DEPTH_LIMIT = { car: 0.3, highwater: 0.9, boat: Infinity };
var HARVEY_STAGE = [
  [0, 0.8],
  [60, 1.6],
  [120, 2.6],
  [180, 3.6],
  [240, 4.4],
  [300, 4.9],
  [360, 5.1]
];
var TRIBUTARY_RISE = 0.5;
var UNDERPASS_CLOSE = { car: 1.4, highwater: 2.6 };
var DI = [1, -1, 0, 0];
var DJ = [0, 0, 1, -1];

// src/routing.ts
var SPEED_KMH = [88, 72, 56, 48, 44, 32, 32, 16];
var EMERGENCY = 1.15;
var VEHICLE_FACTOR = { car: 1, highwater: 0.75, boat: 0.45 };
var STORM_FACTOR = 0.7;
var Router = class {
  constructor(city, flood) {
    this.city = city;
    this.flood = flood;
    const mk = (kind) => {
      const a = new Float64Array(city.m);
      for (let e = 0; e < city.m; e++) {
        const kmh = SPEED_KMH[city.eCls[e]] * EMERGENCY * STORM_FACTOR * VEHICLE_FACTOR[kind];
        a[e] = 60 / (kmh * 1e3);
      }
      return a;
    };
    this.pace = { car: mk("car"), highwater: mk("highwater"), boat: mk("boat") };
  }
  heap = new NumHeap();
  /** Minutes per meter for each edge, per vehicle kind. */
  pace;
  searches = 0;
  /** Dijkstra from `source`. The graph is undirected, so time[v] is also the time from v to the source. */
  search(source, kind, t, limit = Infinity) {
    this.searches++;
    const { city } = this;
    const time = new Float64Array(city.n).fill(Infinity);
    const via = new Int32Array(city.n).fill(-1);
    const close = this.flood.edgeClose[kind];
    const pace = this.pace[kind];
    const stage = this.flood.stage(t);
    const heap = this.heap;
    heap.clear();
    time[source] = 0;
    heap.push(0, source);
    while (heap.size > 0) {
      const d = heap.topKey();
      const v = heap.pop();
      if (d > time[v]) continue;
      if (d > limit) break;
      for (let k = city.adjStart[v]; k < city.adjStart[v + 1]; k++) {
        const e = city.adjEdge[k];
        if (stage >= close[e]) continue;
        const w = city.eA[e] === v ? city.eB[e] : city.eA[e];
        const nd = d + city.eLen[e] * pace[e];
        if (nd < time[w]) {
          time[w] = nd;
          via[w] = e;
          heap.push(nd, w);
        }
      }
    }
    return { time, via, source, kind, t };
  }
  /**
   * Route from `from` to the search's source as a polyline with the cumulative minutes at each vertex.
   * Returns null when the flood has cut `from` off.
   */
  route(s, from) {
    if (!Number.isFinite(s.time[from])) return null;
    const { city } = this;
    const pts = [city.nx[from], city.ny[from]];
    const mins = [0];
    const pace = this.pace[s.kind];
    let v = from;
    let acc = 0;
    while (v !== s.source) {
      const e = s.via[v];
      const w = city.other(e, v);
      const p = city.edgePoints(e, v);
      let len = 0;
      for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
      const edgeMins = city.eLen[e] * pace[e];
      for (let i = 2; i < p.length; i += 2) {
        acc += len > 0 ? Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) / len * edgeMins : 0;
        pts.push(p[i], p[i + 1]);
        mins.push(acc);
      }
      v = w;
    }
    return { pts, mins, total: acc };
  }
};

// src/rng.ts
var Rng = class {
  state;
  constructor(seed) {
    this.state = mix32(seed >>> 0);
  }
  /** Uniform float in [0, 1). */
  next() {
    let t = this.state = this.state + 1831565813 >>> 0;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  /** Uniform integer in [lo, hi). */
  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo));
  }
  chance(p) {
    return this.next() < p;
  }
  pick(items) {
    return items[this.int(0, items.length)];
  }
  shuffle(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
};
function mix32(x) {
  x = x + 2654435769 >>> 0;
  x = Math.imul(x ^ x >>> 16, 2246822507) >>> 0;
  x = Math.imul(x ^ x >>> 13, 3266489909) >>> 0;
  return (x ^ x >>> 16) >>> 0;
}
function deriveSeed(root, ...labels) {
  let h = mix32(root);
  for (const l of labels) h = mix32(h ^ mix32(l + 19088743));
  return h;
}

// src/transcripts.ts
var OPENERS = ["please help", "hi yes", "oh my god please", "hello?", "i need help", "yes hi", "please send someone", "", "ok so", "help us"];
var CLOSERS = ["please hurry", "please", "how long will it take", "we need help now", "oh god", "please send somebody", "", "", "thank you"];
var NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
var SUFFIX = {
  Street: "st",
  Drive: "dr",
  Avenue: "ave",
  Boulevard: "blvd",
  Lane: "ln",
  Road: "rd",
  Court: "ct",
  Circle: "cir",
  Place: "pl",
  Parkway: "pkwy",
  Way: "way",
  Trail: "trl"
};
function addressPhrase(rng, a) {
  const words = a.street.split(" ");
  const last = words[words.length - 1];
  const bare = SUFFIX[last] ? words.slice(0, -1).join(" ") : a.street;
  const abbr = SUFFIX[last] ? `${bare} ${SUFFIX[last]}` : a.street;
  const r = rng.next();
  if (r < 0.1) return null;
  if (r < 0.4) return `${a.number} ${a.street}`;
  if (r < 0.6) return `${a.number} ${bare}`;
  if (r < 0.75) return `${a.number} ${abbr}`;
  if (r < 0.88) return `${bare}, the number is ${a.number}`;
  return `${String(a.number).split("").map((d) => NUM[+d]).join(" ")} ${bare}`;
}
function peoplePhrase(rng, inc) {
  const n = inc.people;
  const v = inc.vuln;
  const parts = [];
  if (n === 1) parts.push(rng.pick(["it is just me", "i'm by myself", "i'm alone here"]));
  else if (n === 2) parts.push(rng.pick(["me and my wife", "me and my husband", "my mom and me", "two of us"]));
  else parts.push(rng.pick([`there are ${n} of us`, `${n} people here`, `we have ${n} people`, `${NUM[n] ?? n} of us`]));
  if (v.infant) parts.push(rng.pick(["i have a baby", "my baby is with me", "we have a newborn", "my daughter is 4 months old"]));
  if (v.elderly) parts.push(rng.pick(["my dad is 84", "my grandmother is with us", "she's elderly", "my mother is 79 years old"]));
  if (v.mobility) parts.push(rng.pick(["he's in a wheelchair", "she can't walk", "my husband is bedridden", "my son is disabled"]));
  if (v.medical) parts.push(rng.pick(["she is on oxygen", "he needs dialysis", "i'm pregnant", "he is diabetic and needs insulin"]));
  return parts.join(", ");
}
function depthPhrase(rng, depth) {
  if (depth < 0.1) return rng.pick(["the street is flooding", "water is in the yard", "the water keeps rising outside"]);
  if (depth < 0.35) return rng.pick(["water is coming in the house", "water is coming under the door", "there is water inside now", "water is up to my ankles"]);
  if (depth < 0.8) return rng.pick(["water is up to our knees", "the water is knee deep in the house", "water is at my knees and rising"]);
  if (depth < 1.2) return rng.pick(["water is up to our waist", "water is waist deep", "the water is at my waist"]);
  if (depth < 1.7) return rng.pick(["water is up to my chest", "it's chest deep in here", "the water is at our chest"]);
  return rng.pick(["we're in the attic", "we had to go up in the attic", "we're on the roof", "we are on the roof now", "water is almost to the ceiling"]);
}
var TYPE_TEXT = {
  vehicle_in_water: [
    "my car stalled in the water and it is rising",
    "we drove into high water and the car is floating",
    "our car got swept off the road into the water",
    "i'm stuck in my truck, water is coming in the doors"
  ],
  cardiac_arrest: [
    "my husband collapsed and he's not breathing",
    "my dad isn't breathing, i can't find a pulse",
    "she just collapsed, she is unresponsive and turning blue",
    "he's not breathing, i'm doing cpr"
  ],
  breathing: [
    "my son is having an asthma attack and can't breathe",
    "my mother is having trouble breathing",
    "he can't catch his breath, he's wheezing really bad",
    "i can't breathe, my inhaler isn't working"
  ],
  chest_pain: [
    "my husband has really bad chest pain",
    "i think i'm having a heart attack, my chest hurts",
    "my dad says his chest is tight and his arm hurts"
  ],
  stroke: [
    "my mom's face is drooping and she's slurring her words",
    "i think my husband is having a stroke, he can't move his left arm",
    "she suddenly cannot talk right and her face is drooping"
  ],
  medical_dependency: [
    "my mother is on oxygen and the power is out, her tank is running out",
    "my husband missed dialysis and is getting weak",
    "the power went out and my dad's oxygen machine stopped",
    "she's on a ventilator and the battery is almost dead"
  ],
  injury: [
    "my wife fell and hit her head, she is bleeding",
    "i fell and i think my leg is broken",
    "he cut his hand really bad on glass, lots of bleeding"
  ],
  fire: [
    "there's a fire in the kitchen, smoke everywhere",
    "the house next door is on fire",
    "there are sparks and smoke coming from the breaker box, something is burning"
  ],
  gas_leak: ["i smell gas really strong in the house", "there is a gas leak, it smells like rotten eggs", "we smell gas outside near the meter"],
  crime: [
    "someone is trying to break into my house",
    "people are looting the store across the street",
    "a man has a gun and is threatening people"
  ],
  welfare: [
    "i can't reach my grandmother, she lives alone and isn't answering",
    "i haven't heard from my dad since the storm started, can someone check on him",
    "please check on my elderly neighbor, her lights are off and she is not answering"
  ]
};
var INFO_TEXT = [
  "where is the nearest shelter",
  "is the freeway open, can i drive to my sister house",
  "the power is out on our street, when is it coming back",
  "i just want to report the street is flooded, we're fine",
  "how do i get sandbags",
  "is it safe to leave, we're ok but worried",
  "my street is flooded but we are on the second floor and fine, just letting you know"
];
function transcript(rng, c) {
  const where = addressPhrase(rng, c.addr);
  return { text: say(rng, c, where), addressGiven: where !== null };
}
function say(rng, c, where) {
  const { inc } = c;
  const parts = [rng.pick(OPENERS)];
  if (c.attempt > 1) {
    const mins = Math.max(20, Math.round(c.minutesWaiting / 10) * 10);
    const flooded = inc.type === "water_rescue" || inc.type === "vehicle_in_water";
    parts.push(rng.pick([`i called ${mins} minutes ago and nobody came`, "this is my third time calling", flooded ? "i already called, where is the boat" : "i already called, where is the ambulance", `we've been waiting for ${mins} minutes`]));
  }
  if (inc.type === "info") {
    parts.push(rng.pick(INFO_TEXT));
    if (where && rng.chance(0.5)) parts.push(`i'm at ${where}`);
    return finish(rng, parts);
  }
  if (inc.type === "water_rescue") {
    if (c.thirdParty) {
      parts.push(
        rng.pick([
          `my mother lives at ${where ?? "her house"} and she is trapped, the water is rising`,
          `my neighbors at ${where ?? "next door"} are trapped and need a boat`,
          `my family is stuck at ${where ?? "their house"}, they texted me`
        ])
      );
      parts.push(depthPhrase(rng, c.depth));
    } else {
      parts.push(rng.pick(["we're trapped in our house", "we need a boat", "we are stuck, the water is rising fast", "we need to be rescued"]));
      parts.push(depthPhrase(rng, c.depth));
      if (where) parts.push(rng.pick([`we are at ${where}`, `the address is ${where}`, `${where}`, `i'm at ${where}`]));
      else parts.push(rng.pick(["i don't know the address", "i don't know the exact address, we just moved here"]));
    }
    parts.push(peoplePhrase(rng, inc));
    return finish(rng, parts);
  }
  const lines = TYPE_TEXT[inc.type];
  parts.push(rng.pick(lines));
  if (inc.type === "vehicle_in_water") parts.push(rng.pick(["water is up to the windows", "water is coming in fast", "the car won't start"]));
  else if (c.depth > 0.3 && rng.chance(0.6)) parts.push(depthPhrase(rng, c.depth));
  if (inc.vuln.elderly && rng.chance(0.6)) parts.push(rng.pick(["he is 81", "she is 77 years old", "she is elderly"]));
  if (where) parts.push(rng.pick([`we are at ${where}`, `the address is ${where}`, `${where}`, `${c.thirdParty ? "they are at" : "i'm at"} ${where}`]));
  else parts.push("i don't know the address");
  return finish(rng, parts);
}
function finish(rng, parts) {
  parts.push(rng.pick(CLOSERS));
  let s = parts.filter(Boolean).join(rng.chance(0.4) ? " " : ". ");
  if (rng.chance(0.5)) s = s.replace(/[.,?]/g, "");
  if (rng.chance(0.3)) s = s.replace(/ (the|is) /, " uh $1 ");
  if (rng.chance(0.5)) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

// src/scenario.ts
var BACKGROUND_RATE = 0.55;
var BACKGROUND_MIX = [
  ["cardiac_arrest", 5],
  ["breathing", 11],
  ["chest_pain", 9],
  ["stroke", 5],
  ["medical_dependency", 9],
  ["injury", 12],
  ["fire", 5],
  ["gas_leak", 4],
  ["crime", 7],
  ["welfare", 9],
  ["info", 30]
];
var RESCUE_SHARE = 0.08;
var VEHICLE_SHARE = 0.025;
function makeScenario(city, flood, opts) {
  const minutes = opts.minutes ?? 360;
  const intensity = opts.intensity ?? 1;
  const rng = new Rng(deriveSeed(opts.seed, 1));
  const incidents = [];
  const add = (type, t0, addrId, people, vuln) => {
    const a = city.addresses[addrId];
    incidents.push({ id: incidents.length, type, t0, address: addrId, x: a.x, y: a.y, node: a.node, people, vuln, severity: 0.7 + 0.6 * rng.next() });
  };
  for (const a of city.addresses) {
    const wet = flood.timeToDepth(a.x, a.y, 0.4);
    if (!(wet < minutes)) continue;
    if (rng.chance(RESCUE_SHARE * intensity)) {
      const t0 = wet + rng.next() * 25;
      if (t0 < minutes) add("water_rescue", t0, a.id, household(rng), vulnerability(rng, "water_rescue"));
    } else if (rng.chance(VEHICLE_SHARE * intensity)) {
      const t0 = Math.max(0, wet - 20 + rng.next() * 30);
      if (t0 < minutes) add("vehicle_in_water", t0, a.id, 1 + (rng.chance(0.4) ? 1 : 0), vulnerability(rng, "vehicle_in_water"));
    }
  }
  const total = BACKGROUND_MIX.reduce((s, [, w]) => s + w, 0);
  for (let t = rng.next(); t < minutes; ) {
    const rate = BACKGROUND_RATE * intensity * (1 + 0.8 * t / minutes);
    t += -Math.log(1 - rng.next()) / rate;
    if (t >= minutes) break;
    let r = rng.next() * total;
    let type = "info";
    for (const [k, w] of BACKGROUND_MIX) {
      if ((r -= w) < 0) {
        type = k;
        break;
      }
    }
    add(type, t, rng.int(0, city.addresses.length), 1, vulnerability(rng, type));
  }
  incidents.sort((a, b) => a.t0 - b.t0);
  incidents.forEach((inc, i) => inc.id = i);
  const calls2 = makeCalls(city, flood, incidents, minutes, new Rng(deriveSeed(opts.seed, 2)));
  return { seed: opts.seed, minutes, callTakers: opts.callTakers ?? 16, incidents, calls: calls2 };
}
function household(rng) {
  let n = 1;
  while (n < 7 && rng.chance(0.55)) n++;
  return n;
}
function vulnerability(rng, type) {
  const old = type === "cardiac_arrest" || type === "stroke" || type === "chest_pain" || type === "medical_dependency" ? 0.6 : 0.22;
  return {
    elderly: rng.chance(old),
    infant: type === "water_rescue" && rng.chance(0.1),
    mobility: rng.chance(type === "water_rescue" ? 0.1 : 0.05),
    medical: type === "medical_dependency" || rng.chance(type === "water_rescue" ? 0.08 : 0.03)
  };
}
function phone(rng) {
  return `713-${String(rng.int(200, 999))}-${String(rng.int(1e3, 9999))}`;
}
function makeCalls(city, flood, incidents, minutes, rng) {
  const calls2 = [];
  for (const inc of incidents) {
    const urgent = inc.type === "cardiac_arrest" || inc.type === "fire" || inc.type === "vehicle_in_water";
    const flood_ = inc.type === "water_rescue" || inc.type === "vehicle_in_water";
    const callers = [];
    const thirdParty = inc.type === "water_rescue" ? rng.chance(0.25) : inc.type === "welfare" ? true : rng.chance(0.08);
    callers.push({ phone: phone(rng), thirdParty, first: inc.t0 + (urgent ? rng.next() * 2 : rng.next() * 8) });
    const extra = inc.type === "water_rescue" ? poisson(rng, 0.7) : inc.type === "fire" ? poisson(rng, 1.2) : 0;
    for (let k = 0; k < extra; k++) callers.push({ phone: phone(rng), thirdParty: true, first: inc.t0 + 5 + rng.next() * 50 });
    for (const c of callers) {
      let t = c.first;
      for (let attempt = 1; t < minutes && attempt <= (flood_ ? 6 : 3); attempt++) {
        const a = city.addresses[inc.address];
        const ali = c.thirdParty ? farAway(rng, city) : near(rng, a.x, a.y);
        calls2.push({
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
          thirdParty: c.thirdParty
        });
        if (inc.type === "info") break;
        t += (flood_ ? 25 : 35) + rng.next() * 25;
      }
    }
  }
  calls2.sort((a, b) => a.t - b.t);
  calls2.forEach((c, i) => c.id = i);
  return calls2;
}
function said(s) {
  return { transcript: s.text, addressGiven: s.addressGiven };
}
function poisson(rng, mean2) {
  let k = 0;
  let p = Math.exp(-mean2);
  let s = p;
  const u = rng.next();
  while (u > s) {
    k++;
    p *= mean2 / k;
    s += p;
  }
  return k;
}
function near(rng, x, y) {
  const r = 50 + rng.next() * 250;
  const a = rng.next() * Math.PI * 2;
  const d = r * Math.sqrt(rng.next());
  return [x + Math.cos(a) * d, y + Math.sin(a) * d, r];
}
function farAway(rng, city) {
  const [x0, y0, x1, y1] = city.bounds;
  return [x0 + rng.next() * (x1 - x0), y0 + rng.next() * (y1 - y0), 100 + rng.next() * 400];
}

// src/sim.ts
var DT = 0.5;
var ON_SCENE = { water_rescue: 18, vehicle_in_water: 15, fire: 35, gas_leak: 20, crime: 20, welfare: 15 };
var MEDIC_SCENE = 14;
var HOSPITAL_HANDOFF = 15;
var TURN_BACK = 12;
var FIND_RADIUS = 200;
var Sim = class {
  constructor(city, flood, scenario, policy, fleet, router) {
    this.city = city;
    this.flood = flood;
    this.scenario = scenario;
    this.policy = policy;
    this.router = router ?? new Router(city, flood);
    this.units = fleet.map((u, id) => ({ ...u, id, node: city.stations[u.station].node, busy: false, cad: -1, legs: [] }));
    this.calls = scenario.calls.map((c) => ({ call: c.id, rang: [], answered: -1, abandoned: 0, cad: -1, merged: false, suppressed: false }));
    const n = scenario.incidents.length;
    this.resolvedAt = new Float64Array(n).fill(Infinity);
    this.survived = new Float64Array(n).fill(NaN);
    this.firstCall = new Float64Array(n).fill(Infinity);
    for (const c of scenario.calls) this.firstCall[c.incident] = Math.min(this.firstCall[c.incident], c.t);
    this.takers = Array.from({ length: scenario.callTakers }, () => ({ call: -1, until: 0 }));
    this.hospitals = city.stations.filter((s) => s.kind === "hospital").map((s) => s.node);
  }
  router;
  units;
  cads = [];
  calls;
  resolvedAt;
  survived;
  firstCall;
  now = 0;
  nextRing = 0;
  hold = [];
  redial = [];
  takers;
  events = [];
  searchCache = /* @__PURE__ */ new Map();
  hospitals;
  counters = { duplicateTrips: 0, wrongLocationTrips: 0, turnedBack: 0, abandoned: 0, suppressed: 0, repeat: 0 };
  get done() {
    return this.now >= this.scenario.minutes;
  }
  run() {
    while (!this.done) this.step();
    return this.metrics();
  }
  step() {
    const t = this.now;
    const sc = this.scenario;
    this.events.sort((a, b) => a.t - b.t);
    while (this.events.length && this.events[0].t <= t) this.handle(this.events.shift());
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
    this.hold = this.hold.filter((h) => {
      if (t - h.since <= h.patience) return true;
      this.counters.abandoned++;
      this.calls[h.call].abandoned++;
      if (h.tries < 2) this.redial.push({ call: h.call, at: t + 3 + 5 * rand(h.call, 7 + h.tries), tries: h.tries + 1 });
      return false;
    });
    for (const k of this.takers) {
      if (k.call >= 0 && k.until <= t) {
        const call = sc.calls[k.call];
        this.calls[k.call].answered = t;
        k.call = -1;
        if (this.resolvedAt[call.incident] <= t) this.calls[call.id].suppressed = true;
        else this.policy.intake(call, t, this);
      }
      if (k.call < 0 && this.hold.length) {
        const h = this.hold.shift();
        k.call = h.call;
        k.until = t + 1.2 + 1.8 * rand(h.call, 3);
      }
    }
    for (const [u, c] of this.policy.dispatch(t, this)) this.assign(u, c, t);
    this.now = t + DT;
  }
  ring(call, t, tries) {
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
  openCad(call, now, f) {
    const cad = { ...f, id: this.cads.length, opened: now, calls: [call.id], status: "waiting", unit: -1, assignedAt: -1, closedAt: -1, truths: [call.incident], blocked: [] };
    this.cads.push(cad);
    this.calls[call.id].cad = cad.id;
    if (CAN_SERVE[cad.type].length === 0) this.close(cad, now, "no_dispatch");
    return cad;
  }
  mergeCad(call, cad) {
    cad.calls.push(call.id);
    if (!cad.truths.includes(call.incident)) cad.truths.push(call.incident);
    this.calls[call.id].cad = cad.id;
    this.calls[call.id].merged = true;
  }
  close(cad, now, outcome) {
    cad.status = "closed";
    cad.closedAt = now;
    cad.outcome = outcome;
  }
  openCads() {
    return this.cads.filter((c) => c.status !== "closed");
  }
  idleUnits() {
    return this.units.filter((u) => !u.busy);
  }
  /** Travel minutes from every node to `node` for a vehicle kind, with the roads closed at time t (cached per 10 minutes). */
  timesTo(node, vehicle, t) {
    const key = `${node}|${vehicle}|${Math.floor(t / 10)}`;
    let v = this.searchCache.get(key);
    if (!v) {
      v = Float32Array.from(this.router.search(node, vehicle, Math.floor(t / 10) * 10 + 5).time);
      if (this.searchCache.size > 400) this.searchCache.delete(this.searchCache.keys().next().value);
      this.searchCache.set(key, v);
    }
    return v;
  }
  // ------------------------------------------------------------ units
  assign(uid, cid, t) {
    const u = this.units[uid];
    const cad = this.cads[cid];
    if (u.busy || cad.status !== "waiting") return;
    u.busy = true;
    u.cad = cid;
    cad.status = "assigned";
    cad.unit = uid;
    cad.assignedAt = t;
    const s = this.router.search(cad.node, u.vehicle, t);
    const route = this.router.route(s, u.node);
    if (!route) {
      this.counters.turnedBack++;
      u.legs.push({ t0: t, t1: t + TURN_BACK, kind: "turned_back", cad: cid });
      cad.status = "waiting";
      cad.unit = -1;
      if (!cad.blocked.includes(u.vehicle)) cad.blocked.push(u.vehicle);
      this.events.push({ t: t + TURN_BACK, unit: uid, kind: "free" });
      return;
    }
    u.legs.push({ t0: t, t1: t + route.total, kind: "drive", cad: cid, route });
    this.events.push({ t: t + route.total, unit: uid, kind: "arrive" });
  }
  handle(ev) {
    const u = this.units[ev.unit];
    if (ev.kind === "free") {
      u.busy = false;
      u.cad = -1;
      return;
    }
    const cad = this.cads[u.cad];
    u.node = cad.node;
    const t = ev.t;
    const sc = this.scenario;
    let found = null;
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
      this.close(cad, t, alreadyDone ? "duplicate" : "wrong_location");
      this.events.push({ t, unit: u.id, kind: "free" });
      return;
    }
    this.close(cad, t, "served");
    const scene = u.kind === "medic" ? MEDIC_SCENE : (ON_SCENE[found.type] ?? 15) + (found.type === "water_rescue" ? 3 * found.people : 0);
    u.legs.push({ t0: t, t1: t + scene, kind: "scene", cad: cad.id });
    let free = t + scene;
    if (u.kind === "medic") {
      const leg = this.transport(u, t + scene);
      if (leg) {
        u.legs.push(leg);
        u.node = leg.route ? this.hospitalAt(leg.route) : u.node;
        free = leg.t1 + HOSPITAL_HANDOFF;
      }
    }
    this.events.push({ t: free, unit: u.id, kind: "free" });
  }
  transport(u, t) {
    const s = this.router.search(u.node, u.vehicle, t);
    let best = -1;
    for (const h of this.hospitals) if (Number.isFinite(s.time[h]) && (best < 0 || s.time[h] < s.time[best])) best = h;
    if (best < 0) return null;
    const back = this.router.route(s, best);
    return { t0: t, t1: t + back.total, kind: "transport", cad: u.cad, route: reverse(back) };
  }
  hospitalAt(r) {
    const x = r.pts[r.pts.length - 2];
    const y = r.pts[r.pts.length - 1];
    let best = this.hospitals[0];
    for (const h of this.hospitals) if (Math.hypot(this.city.nx[h] - x, this.city.ny[h] - y) < Math.hypot(this.city.nx[best] - x, this.city.ny[best] - y)) best = h;
    return best;
  }
  metrics() {
    const sc = this.scenario;
    const end = sc.minutes + 60;
    let people = 0;
    let deaths = 0;
    let prevent = 0;
    let served = 0;
    let unserved = 0;
    const p1 = [];
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
      cadEntries: this.cads.length
    };
  }
};
function isLifeThreat(t) {
  return t === "water_rescue" || t === "vehicle_in_water" || t === "cardiac_arrest" || t === "fire" || t === "breathing";
}
function truthRisk(inc, flood) {
  return { type: inc.type, vuln: inc.vuln, severity: inc.severity, depthAt: (t) => flood.depthAt(inc.x, inc.y, t) };
}
function reverse(r) {
  const pts = [];
  const mins = [];
  for (let i = r.mins.length - 1; i >= 0; i--) {
    pts.push(r.pts[2 * i], r.pts[2 * i + 1]);
    mins.push(r.total - r.mins[i]);
  }
  return { pts, mins, total: r.total };
}
function rand(call, salt) {
  return mix32(mix32(call * 7919 + salt)) / 4294967296;
}
function defaultFleet(city, opts = {}) {
  const fleet = [];
  const fire = city.stations.filter((s) => s.kind === "fire");
  const police = city.stations.filter((s) => s.kind === "police");
  const rescueEvery = Math.max(1, Math.round(fire.length / (opts.rescueTeams ?? 22)));
  const medicEvery = 1 / (opts.medicShare ?? 0.7);
  fire.forEach((s, i) => {
    const short = s.name.replace(/Houston Fire (Station|Department Station)/, "Station").replace(/ Fire Department$/, "");
    fleet.push({ kind: "engine", vehicle: "highwater", station: s.id, name: `Engine \xB7 ${short}` });
    if (Math.floor(i / medicEvery) !== Math.floor((i + 1) / medicEvery)) fleet.push({ kind: "medic", vehicle: "car", station: s.id, name: `Medic \xB7 ${short}` });
    if (i % rescueEvery === 0) fleet.push({ kind: "rescue", vehicle: "boat", station: s.id, name: `Boat \xB7 ${short}` });
  });
  police.forEach((s) => {
    fleet.push({ kind: "police", vehicle: "car", station: s.id, name: `Patrol \xB7 ${s.name}` });
    fleet.push({ kind: "police", vehicle: "car", station: s.id, name: `Patrol \xB7 ${s.name}` });
  });
  return fleet;
}

// src/cli.ts
var HELP = `surge - a 911 dispatch copilot for disaster call surges (Houston, Hurricane Harvey night)

usage:
  surge bench [--seeds 10] [--from 101] [--intensity 1]   compare dispatch policies over many simulated storms
  surge triage "<what the caller said>"                    triage one call against real Houston addresses
  surge calls [--seed 1] [--n 12]                          print sample calls from a scenario
`;
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
}
function loadCity() {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = [join(here, "../data/houston.json"), join(here, "../../data/houston.json")].find((p) => {
    try {
      readFileSync(p, { flag: "r" });
      return true;
    } catch {
      return false;
    }
  });
  if (!path) throw new Error("data/houston.json not found; run `npm run data` first");
  return new City(JSON.parse(readFileSync(path, "utf8")));
}
function bench() {
  const seeds = arg("seeds", 10);
  const from = arg("from", 101);
  const intensity = arg("intensity", 1);
  const city = loadCity();
  const flood = new FloodModel(city);
  const router = new Router(city, flood);
  const fleet = defaultFleet(city);
  const policies = [
    fifoPolicy,
    cadPolicy,
    cadRoutedPolicy,
    () => surgePolicy(city, { forecast: false, name: "Surge, no flood forecast" }),
    () => surgePolicy(city)
  ];
  const rows = /* @__PURE__ */ new Map();
  console.log(`${city.name}: ${city.n} road nodes, ${city.m} road links, ${city.addresses.length} addresses, ${fleet.length} units`);
  for (let s = from; s < from + seeds; s++) {
    const sc = makeScenario(city, flood, { seed: s, intensity });
    const line = [];
    for (const mk of policies) {
      const p = mk();
      const m = new Sim(city, flood, sc, p, fleet, router).run();
      if (!rows.has(p.name)) rows.set(p.name, []);
      rows.get(p.name).push(m);
      line.push(`${p.name.split(" ")[0]} ${m.deaths.toFixed(1)}`);
    }
    console.log(`storm ${s}: ${sc.incidents.length} emergencies, ${sc.calls.length} potential calls | deaths  ${line.join("  ")}`);
  }
  const cols = [
    ["deaths", (m) => m.deaths, 1],
    ["reached", (m) => m.incidentsServed, 0],
    ["P1 median min", (m) => m.p1ResponseMedian, 1],
    ["P1 p90 min", (m) => m.p1ResponseP90, 1],
    ["P1 never reached", (m) => m.p1Unreached, 1],
    ["turned back", (m) => m.turnedBack, 0],
    ["wasted trips", (m) => m.duplicateTrips + m.wrongLocationTrips, 1],
    ["repeat calls", (m) => m.repeatCalls, 0]
  ];
  console.log(`
mean over ${seeds} storms (95% CI for deaths)`);
  console.log(["policy".padEnd(26), ...cols.map(([h]) => h.padStart(16))].join(""));
  const base = mean(rows.get("Standard CAD").map((m) => m.deaths));
  for (const [name, ms] of rows) {
    const d = ms.map((m) => m.deaths);
    const cells = cols.map(([, f, dp], i) => {
      const v = mean(ms.map(f));
      return (i === 0 ? `${v.toFixed(1)} \xB1${ci(d).toFixed(1)}` : v.toFixed(dp)).padStart(16);
    });
    console.log([name.padEnd(26), ...cells].join(""));
  }
  const surge = mean(rows.get("Surge copilot").map((m) => m.deaths));
  console.log(`
Surge copilot vs standard CAD: ${(100 * (1 - surge / base)).toFixed(0)}% fewer deaths`);
}
function triage() {
  const text = process.argv.slice(3).join(" ");
  if (!text) return void console.log(HELP);
  const city = loadCity();
  const flood = new FloodModel(city);
  const t0 = performance.now();
  const r = new Triager(city).triage(text);
  const ms = performance.now() - t0;
  console.log(`${TYPE_LABEL[r.type]}  (acuity ${r.acuity}, confidence ${(r.confidence * 100).toFixed(0)}%, ${ms.toFixed(2)} ms)`);
  console.log(`where:   ${r.address ? `${r.address.number} ${r.address.street}` : "no address heard, use phone location"}`);
  console.log(`who:     ${r.people} ${r.people === 1 ? "person" : "people"}${Object.entries(r.vuln).filter(([, v]) => v).map(([k]) => `, ${k}`).join("")}`);
  if (r.reportedDepth !== null) console.log(`water:   caller reports ~${r.reportedDepth} m`);
  if (r.address) {
    const crit = flood.timeToDepth(r.address.x, r.address.y, 1.2);
    console.log(`forecast: ${Number.isFinite(crit) ? `water reaches 1.2 m here at ${clock(crit)}` : "this address stays below 1.2 m tonight"}`);
  }
  console.log("evidence:");
  for (const e of r.evidence) console.log(`  "${e.text}" -> ${e.label}`);
}
function calls() {
  const city = loadCity();
  const flood = new FloodModel(city);
  const sc = makeScenario(city, flood, { seed: arg("seed", 1) });
  for (const c of sc.calls.slice(0, arg("n", 12))) console.log(`${clock(c.t)}  ${c.transcript}`);
}
function clock(t) {
  const m = Math.round(22 * 60 + t) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function mean(a) {
  return a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
}
function ci(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
  return 1.96 * sd / Math.sqrt(a.length);
}
var cmd = process.argv[2];
if (cmd === "bench") bench();
else if (cmd === "triage") triage();
else if (cmd === "calls") calls();
else console.log(HELP);
export {
  clock
};
