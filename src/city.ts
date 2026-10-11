/** The real-world city model: road graph, stations, street addresses and terrain, built by data/build.py from Overture Maps and AWS Terrain Tiles. */

export interface CityData {
  name: string;
  origin: [number, number];
  scale: [number, number];
  bounds: [number, number, number, number];
  roadClasses: string[];
  nodes: number[];
  /** Six numbers per edge: a, b, length (m), road class (+16 bridge, +32 tunnel), street name index, offset into shapes. */
  edges: number[];
  shapes: number[];
  streetNames: string[];
  stations: { kind: StationKind; name: string; x: number; y: number; node: number }[];
  addrStreets: string[];
  /** Five numbers per address: x, y, house number, street index, nearest road node. */
  addresses: number[];
  grid: { x0: number; y0: number; cell: number; w: number; h: number; elevDm: string; drain: string };
  water: number[][];
  sources: string[];
}

export type StationKind = 'fire' | 'police' | 'hospital';

export interface Station {
  id: number;
  kind: StationKind;
  name: string;
  x: number;
  y: number;
  node: number;
}

export interface Address {
  id: number;
  x: number;
  y: number;
  number: number;
  street: string;
  node: number;
}

export class City {
  readonly name: string;
  readonly bounds: [number, number, number, number];
  readonly n: number;
  readonly m: number;
  readonly nx: Float64Array;
  readonly ny: Float64Array;
  readonly eA: Int32Array;
  readonly eB: Int32Array;
  readonly eLen: Float32Array;
  readonly eCls: Uint8Array;
  /** 1 = bridge, 2 = tunnel/underpass. */
  readonly eFlags: Uint8Array;
  readonly eName: Int32Array;
  private readonly eShape: Int32Array;
  readonly shapes: Int32Array;
  /** CSR adjacency: the edges touching node v are adjEdge[adjStart[v] .. adjStart[v+1]). */
  readonly adjStart: Int32Array;
  readonly adjEdge: Int32Array;
  readonly streetNames: string[];
  readonly roadClasses: string[];
  readonly stations: Station[];
  readonly addresses: Address[];
  readonly grid: { x0: number; y0: number; cell: number; w: number; h: number };
  readonly elev: Float32Array;
  readonly drain: Uint8Array;
  readonly water: number[][];
  readonly origin: [number, number];
  readonly scale: [number, number];
  readonly sources: string[];

  constructor(d: CityData) {
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

  other(e: number, v: number): number {
    return this.eA[e] === v ? this.eB[e] : this.eA[e];
  }

  /** Polyline of edge e from endpoint `from` to the other end, as flat [x0, y0, x1, y1, ...]. */
  edgePoints(e: number, from = this.eA[e]): number[] {
    const pts = [this.nx[this.eA[e]], this.ny[this.eA[e]]];
    for (let i = this.eShape[e]; i < this.eShape[e + 1]; i++) pts.push(this.shapes[i]);
    pts.push(this.nx[this.eB[e]], this.ny[this.eB[e]]);
    if (from === this.eA[e]) return pts;
    const rev: number[] = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
    return rev;
  }

  cellOf(x: number, y: number): number {
    const { x0, y0, cell, w, h } = this.grid;
    const i = Math.min(w - 1, Math.max(0, Math.floor((x - x0) / cell)));
    const j = Math.min(h - 1, Math.max(0, Math.floor((y - y0) / cell)));
    return j * w + i;
  }

  /** Nearest road node by straight-line distance (linear scan; only used outside hot loops). */
  nearestNode(x: number, y: number): number {
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

  toLonLat(x: number, y: number): [number, number] {
    return [x / this.scale[0] + this.origin[0], y / this.scale[1] + this.origin[1]];
  }
}

function bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
