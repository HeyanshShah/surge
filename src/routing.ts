import type { City } from './city';
import type { FloodModel, VehicleKind } from './flood';
import { NumHeap } from './heap';

/** Free-flow speeds (km/h) by road class, matching City.roadClasses order. */
const SPEED_KMH = [88, 72, 56, 48, 44, 32, 32, 16];
/** Lights-and-sirens bonus over free flow, and how much slower each vehicle kind is than an ambulance. */
const EMERGENCY = 1.15;
const VEHICLE_FACTOR: Record<VehicleKind, number> = { car: 1, highwater: 0.75, boat: 0.45 };
/** Storm conditions: rain, debris and stalled cars cut speeds on roads that are still open. */
const STORM_FACTOR = 0.7;

export interface Search {
  /** Travel minutes from the source to every node (Infinity if unreachable). */
  time: Float64Array;
  /** Edge used to reach each node (-1 at the source or if unreachable). */
  via: Int32Array;
  source: number;
  kind: VehicleKind;
  t: number;
}

/** Shortest travel times over the road graph with roads closed by the flood at the time of the search. */
export class Router {
  private readonly heap = new NumHeap();
  /** Minutes per meter for each edge, per vehicle kind. */
  private readonly pace: Record<VehicleKind, Float64Array>;
  searches = 0;

  constructor(
    readonly city: City,
    readonly flood: FloodModel,
  ) {
    const mk = (kind: VehicleKind) => {
      const a = new Float64Array(city.m);
      for (let e = 0; e < city.m; e++) {
        const kmh = SPEED_KMH[city.eCls[e]] * EMERGENCY * STORM_FACTOR * VEHICLE_FACTOR[kind];
        a[e] = 60 / (kmh * 1000);
      }
      return a;
    };
    this.pace = { car: mk('car'), highwater: mk('highwater'), boat: mk('boat') };
  }

  /** Dijkstra from `source`. The graph is undirected, so time[v] is also the time from v to the source. */
  search(source: number, kind: VehicleKind, t: number, limit = Infinity): Search {
    this.searches++;
    const { city } = this;
    const time = new Float64Array(city.n).fill(Infinity);
    const via = new Int32Array(city.n).fill(-1);
    const close = this.flood.edgeClose[kind];
    const pace = this.pace[kind];
    const stages = this.flood.stages(t);
    const edgeCh = this.flood.edgeChannel;
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
        if (stages[edgeCh[e]] >= close[e]) continue;
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
  route(s: Search, from: number): Route | null {
    if (!Number.isFinite(s.time[from])) return null;
    const { city } = this;
    const pts: number[] = [city.nx[from], city.ny[from]];
    const mins: number[] = [0];
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
        acc += len > 0 ? (Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) / len) * edgeMins : 0;
        pts.push(p[i], p[i + 1]);
        mins.push(acc);
      }
      v = w;
    }
    return { pts, mins, total: acc };
  }
}

export interface Route {
  pts: number[];
  mins: number[];
  total: number;
}

/** Position along a route `elapsed` minutes after departure. */
export function along(r: Route, elapsed: number): [number, number] {
  const { pts, mins } = r;
  if (elapsed <= 0) return [pts[0], pts[1]];
  for (let i = 1; i < mins.length; i++) {
    if (elapsed <= mins[i]) {
      const f = mins[i] > mins[i - 1] ? (elapsed - mins[i - 1]) / (mins[i] - mins[i - 1]) : 1;
      return [pts[2 * i - 2] + (pts[2 * i] - pts[2 * i - 2]) * f, pts[2 * i - 1] + (pts[2 * i + 1] - pts[2 * i - 1]) * f];
    }
  }
  return [pts[pts.length - 2], pts[pts.length - 1]];
}
