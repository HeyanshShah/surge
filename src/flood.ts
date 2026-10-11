import type { City } from './city';
import { NumHeap } from './heap';

/**
 * Flood forecast from terrain, in the spirit of HAND ("height above nearest drainage", the method behind
 * NOAA's National Water Model inundation maps), with spill barriers.
 *
 * A priority flood seeded at every bayou/channel cell assigns each terrain cell
 *   src   - elevation of the channel cell whose water reaches it first
 *   spill - the lowest water level that can reach it from that channel (the highest ridge on the best path)
 * If the channels sit `stage` meters above their bed, a cell is under water once src + stage >= spill,
 * and its depth is src + stage - elevation. Ridges keep water out of neighborhoods until it overtops them,
 * and bowls behind them fill all at once, which is how Meyerland and Braeswood flooded in 2017.
 */
export class FloodModel {
  readonly src: Float32Array;
  readonly spill: Float32Array;
  /** How much of the main-channel rise reaches the channel a cell drains to (tributaries rise less). */
  readonly rise: Float32Array;
  readonly stagePoints: [number, number][];
  /** Stage (m) at which each edge becomes impassable, per vehicle threshold. */
  readonly edgeClose: Record<VehicleKind, Float32Array>;

  constructor(
    readonly city: City,
    hydrograph: [number, number][] = HARVEY_STAGE,
  ) {
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
      boat: new Float32Array(city.m).fill(Infinity),
    };
    for (let e = 0; e < city.m; e++) {
      if (city.eFlags[e] & 1) {
        // bridges stay above the water; their approaches close instead
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
          const c = city.cellOf(pts[p] + ((pts[p + 2] - pts[p]) * s) / steps, pts[p + 1] + ((pts[p + 3] - pts[p + 1]) * s) / steps);
          car = Math.min(car, this.onset(c, DEPTH_LIMIT.car));
          hw = Math.min(hw, this.onset(c, DEPTH_LIMIT.highwater));
        }
      }
      if (city.eFlags[e] & 2) {
        // underpasses collect runoff long before the bayous crest
        car = Math.min(car, UNDERPASS_CLOSE.car);
        hw = Math.min(hw, UNDERPASS_CLOSE.highwater);
      }
      this.edgeClose.car[e] = car;
      this.edgeClose.highwater[e] = hw;
    }
  }

  /** Channel stage (m above bed) at time t (minutes into the scenario). */
  stage(t: number): number {
    const p = this.stagePoints;
    if (t <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (t <= p[i][0]) {
        const [t0, s0] = p[i - 1];
        const [t1, s1] = p[i];
        return s0 + ((s1 - s0) * (t - t0)) / (t1 - t0);
      }
    }
    return p[p.length - 1][1];
  }

  /** First time the stage reaches s, or Infinity if it never does. */
  timeOfStage(s: number): number {
    const p = this.stagePoints;
    if (s <= p[0][1]) return p[0][0];
    for (let i = 1; i < p.length; i++) {
      const [t0, s0] = p[i - 1];
      const [t1, s1] = p[i];
      if (s1 >= s && s0 < s) return t0 + ((s - s0) * (t1 - t0)) / (s1 - s0);
    }
    return Infinity;
  }

  /** Lowest stage at which cell c has at least `depth` meters of water. */
  onset(c: number, depth: number): number {
    return Math.max(this.spill[c] - this.src[c], this.city.elev[c] + depth - this.src[c]) / this.rise[c];
  }

  depth(c: number, stage: number): number {
    const top = this.src[c] + stage * this.rise[c];
    return top >= this.spill[c] ? Math.max(0, top - this.city.elev[c]) : 0;
  }

  depthAt(x: number, y: number, t: number): number {
    return this.depth(this.city.cellOf(x, y), this.stage(t));
  }

  /** When water at (x, y) first reaches `depth` meters (minutes), or Infinity. */
  timeToDepth(x: number, y: number, depth: number): number {
    return this.timeOfStage(this.onset(this.city.cellOf(x, y), depth));
  }

  passable(e: number, kind: VehicleKind, t: number): boolean {
    return this.stage(t) < this.edgeClose[kind][e];
  }
}

export type VehicleKind = 'car' | 'highwater' | 'boat';

/** Water depth (m) at which each vehicle can no longer use a road. A car stalls in about a foot of water. */
export const DEPTH_LIMIT: Record<VehicleKind, number> = { car: 0.3, highwater: 0.9, boat: Infinity };

/**
 * Channel stage over the scenario night, minutes from 22:00 Aug 26 2017 to 04:00 Aug 27.
 * Shaped after the Brays and Buffalo Bayou gauges that night: a steady rise, then a fast overnight surge
 * under the heaviest rain bands. It is a scenario curve, not a gauge replay.
 */
export const HARVEY_STAGE: [number, number][] = [
  [0, 0.8],
  [60, 1.6],
  [120, 2.6],
  [180, 3.6],
  [240, 4.4],
  [300, 4.9],
  [360, 5.1],
];

const TRIBUTARY_RISE = 0.5;
const UNDERPASS_CLOSE = { car: 1.4, highwater: 2.6 };
const DI = [1, -1, 0, 0];
const DJ = [0, 0, 1, -1];
