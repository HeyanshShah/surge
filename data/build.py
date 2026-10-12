"""Turn the raw real-world inputs in data/raw/ into the compact city model the simulator loads.

usage: python3 data/build.py [--name "Austin, TX (central)" --bbox=-97.80,30.22,-97.68,30.33 --raw data/raw-austin --out data/austin.json]
Output: data/houston.json by default
  road graph      Overture transportation segments split at connectors, largest connected component
  stations        real Houston-area fire stations, police stations and emergency departments (Overture places)
  addresses       a seeded sample of real street addresses, snapped to the road graph (Overture addresses)
  terrain         75 m elevation grid resampled from AWS Terrain Tiles
  drainage        cells touched by bayous, streams and drainage channels (Overture water), used for HAND flood mapping
All coordinates are local meters (x east, y north) around ORIGIN.
"""
import argparse
import base64
import collections
import json
import math
import random
import re
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import shapely
from PIL import Image
from shapely.ops import substring

ap = argparse.ArgumentParser(description="Build a Surge city model from data fetched by fetch.sh")
ap.add_argument("--name", default="Houston, TX (central)")
ap.add_argument("--bbox", default="-95.56,29.62,-95.30,29.82", help="west,south,east,north in degrees")
ap.add_argument("--raw", default=str(Path(__file__).parent / "raw"))
ap.add_argument("--out", default=str(Path(__file__).parent / "houston.json"))
ap.add_argument("--addresses", type=int, default=20000)
ARGS = ap.parse_args()
RAW = Path(ARGS.raw)
OUT = Path(ARGS.out)
W, S, E, N = (float(v) for v in ARGS.bbox.split(","))
LON0, LAT0 = (W + E) / 2, (S + N) / 2
KX, KY = math.cos(math.radians(LAT0)) * 111320.0, 110574.0
CELL = 75.0
ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street"]
DRAIN_CLASSES = {"river", "stream", "canal", "drain", "ditch"}
# named channels only: bayous and rivers are main channels, the rest tributaries
CHANNEL_NAMES = r"bayou|river|creek|branch|gully|diversion|ditch|run|brook|kill|fork|slough|wash|arroyo"


def proj(lon, lat):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def unproj(x, y):
    return x / KX + LON0, y / KY + LAT0


X0, Y0 = proj(W, S)
X1, Y1 = proj(E, N)
GW, GH = int((X1 - X0) // CELL), int((Y1 - Y0) // CELL)


def clean_name(s):
    if not s:
        return ""
    return " ".join(w if not w.isupper() or len(w) <= 2 and w in ("FM",) else w.capitalize() for w in s.split())


# ---------------------------------------------------------------- roads
def build_roads():
    t = pq.read_table(RAW / "segments.parquet").to_pylist()
    pieces = []  # (u, v, coords, cls, name)
    for r in t:
        if r["subtype"] != "road" or r["class"] not in ROAD_CLASSES or not r["connectors"]:
            continue
        g = shapely.from_wkb(r["geometry"])
        if g.geom_type != "LineString":
            continue
        name = clean_name((r["names"] or {}).get("primary"))
        cons = sorted(r["connectors"], key=lambda c: c["at"])
        spans = [(f["between"] or [0.0, 1.0], v) for f in (r["road_flags"] or []) for v in (f["values"] or []) if v in ("is_bridge", "is_tunnel")]
        for a, b in zip(cons, cons[1:]):
            if b["at"] - a["at"] <= 0:
                continue
            part = substring(g, a["at"], b["at"], normalized=True)
            if part.geom_type != "LineString" or part.length == 0:
                continue
            pts = [proj(x, y) for x, y in part.coords]
            if not any(X0 <= x <= X1 and Y0 <= y <= Y1 for x, y in pts):
                continue
            # bit 1: bridge (stays dry over the water), bit 2: tunnel or underpass (floods first)
            flags = 0
            for (lo, hi), v in spans:
                if min(hi, b["at"]) - max(lo, a["at"]) > 0.5 * (b["at"] - a["at"]):
                    flags |= 1 if v == "is_bridge" else 2
            pieces.append((a["connector_id"], b["connector_id"], pts, ROAD_CLASSES.index(r["class"]) | (flags << 4), name))

    # largest connected component
    adj = collections.defaultdict(list)
    for i, (u, v, *_ ) in enumerate(pieces):
        adj[u].append(v)
        adj[v].append(u)
    seen, best = set(), set()
    for s in adj:
        if s in seen:
            continue
        comp, stack = {s}, [s]
        seen.add(s)
        while stack:
            for w in adj[stack.pop()]:
                if w not in seen:
                    seen.add(w)
                    comp.add(w)
                    stack.append(w)
        if len(comp) > len(best):
            best = comp
    pieces = [p for p in pieces if p[0] in best]

    node_id, nodes = {}, []
    def nid(cid, xy):
        if cid not in node_id:
            node_id[cid] = len(nodes)
            nodes.append(xy)
        return node_id[cid]

    names, name_idx = [""], {"": 0}
    edges = []  # [a, b, pts, cls, name]
    for u, v, pts, cls, name in pieces:
        a, b = nid(u, pts[0]), nid(v, pts[-1])
        if a == b:
            continue
        if name not in name_idx:
            name_idx[name] = len(names)
            names.append(name)
        edges.append([a, b, pts, cls, name_idx[name]])
    return nodes, edges, names


def contract(nodes, edges, keep):
    """Merge chains through degree-2 nodes (that no station or address uses) into single edges.
    Routing results are identical; the graph the browser has to search shrinks by roughly half."""
    inc = collections.defaultdict(list)
    for k, e in enumerate(edges):
        inc[e[0]].append(k)
        inc[e[1]].append(k)
    removable = {n for n, ks in inc.items() if len(ks) == 2 and n not in keep and edges[ks[0]][3] == edges[ks[1]][3]}
    used, out = set(), []
    for k, e in enumerate(edges):
        if k in used:
            continue
        used.add(k)
        a, b, pts, cls, name = e[0], e[1], list(e[2]), e[3], e[4]
        # extend forward from b, then backward from a
        for forward in (True, False):
            while True:
                end = b if forward else a
                if end not in removable:
                    break
                nxt = [j for j in inc[end] if j not in used]
                if not nxt:
                    break
                j = nxt[0]
                used.add(j)
                f = edges[j]
                seg = f[2] if f[0] == end else f[2][::-1]
                other = f[1] if f[0] == end else f[0]
                if forward:
                    pts, b = pts + seg[1:], other
                else:
                    pts, a = seg[::-1][:-1] + pts, other
                if a == b:
                    break
        if a != b:
            out.append([a, b, pts, cls, name])
    alive = sorted({n for e in out for n in (e[0], e[1])} | set(keep))
    remap = {n: i for i, n in enumerate(alive)}
    return [nodes[n] for n in alive], [[remap[e[0]], remap[e[1]], *e[2:]] for e in out], remap


def encode_edges(edges):
    flat, shapes = [], []
    for a, b, pts, cls, name in edges:
        line = shapely.LineString(pts)
        inner = [c for xy in list(line.simplify(3.0).coords)[1:-1] for c in (round(xy[0]), round(xy[1]))]
        flat.extend([a, b, round(line.length), cls, name, len(shapes)])
        shapes.extend(inner)
    return flat, shapes


# ---------------------------------------------------------------- terrain + drainage
def build_terrain():
    z = 13
    n = 2 ** z
    tiles = {}
    for p in (RAW / "dem").glob("13_*.png"):
        _, x, y = p.stem.split("_")
        a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
        tiles[(int(x), int(y))] = a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256 - 32768

    def elev(lon, lat):
        fx = (lon + 180) / 360 * n
        fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
        tx, ty = int(fx), int(fy)
        px, py = min(255, int((fx - tx) * 256)), min(255, int((fy - ty) * 256))
        return tiles[(tx, ty)][py, px]

    grid = np.zeros((GH, GW), dtype=np.float64)
    for j in range(GH):
        for i in range(GW):
            # average a 3x3 sample inside the cell to smooth tile noise
            acc = 0.0
            for dj in (-0.33, 0, 0.33):
                for di in (-0.33, 0, 0.33):
                    acc += elev(*unproj(X0 + (i + 0.5 + di) * CELL, Y0 + (j + 0.5 + dj) * CELL))
            grid[j, i] = acc / 9
    return grid


def build_water():
    """Rasterize the named channel network. 2 = main bayou, 1 = tributary creek/branch/gully.
    Unnamed drains and roadside ditches are left out: they are dry most of the time and would seed water on high ground."""
    t = pq.read_table(RAW / "water.parquet").to_pylist()
    drain = np.zeros((GH, GW), dtype=np.uint8)
    lines = []
    for r in t:
        name = (r["names"] or {}).get("primary") or ""
        if r["class"] not in DRAIN_CLASSES or not re.search(CHANNEL_NAMES, name, re.I):
            continue
        main = re.search(r"bayou", name, re.I) or (r["class"] == "river" and re.search(r"river", name, re.I))
        rank = 2 if main and not re.search(r"country club|little", name, re.I) else 1
        g = shapely.from_wkb(r["geometry"])
        g = shapely.transform(g, lambda c: np.column_stack(proj(c[:, 0], c[:, 1])))
        for part in getattr(g, "geoms", [g]):
            ring = part.exterior if part.geom_type == "Polygon" else part
            if ring.geom_type not in ("LineString", "LinearRing") or ring.length < 50:
                continue
            for d in np.arange(0, ring.length, 20.0):
                p = ring.interpolate(d)
                i, j = int((p.x - X0) // CELL), int((p.y - Y0) // CELL)
                if 0 <= i < GW and 0 <= j < GH:
                    drain[j, i] = max(drain[j, i], rank)
            s = ring.simplify(12.0)
            lines.append([rank] + [c for xy in s.coords for c in (round(xy[0]), round(xy[1]))])
    return drain, lines


# ---------------------------------------------------------------- stations + addresses
NOT_POLICE = r"foundation|pension|property|mental|isd|universit|college|rice|\bUT\b|HCC|southern|christian|storefront|store front|security|stations and|association|santa|dispatch"
NOT_HOSPITAL = r"foundation|district|clinic|imaging|pharmacy|lab|rehab|psychiatric|veterinary|animal|surgical|orthopedic|kindred|vibra|acuity|west oaks|elite health|durham|meridian"


class Snapper:
    def __init__(self, nodes, cell=200.0):
        self.nodes, self.cell, self.h = nodes, cell, collections.defaultdict(list)
        for k, (x, y) in enumerate(nodes):
            self.h[(int(x // cell), int(y // cell))].append(k)

    def nearest(self, x, y, maxd=400.0):
        cx, cy, best, bd = int(x // self.cell), int(y // self.cell), -1, maxd * maxd
        r = int(maxd // self.cell) + 1
        for i in range(cx - r, cx + r + 1):
            for j in range(cy - r, cy + r + 1):
                for k in self.h.get((i, j), ()):
                    nx, ny = self.nodes[k]
                    d = (nx - x) ** 2 + (ny - y) ** 2
                    if d < bd:
                        best, bd = k, d
        return best, math.sqrt(bd)


def build_stations(snap):
    t = pq.read_table(RAW / "places.parquet").to_pylist()
    out = {"fire": [], "police": [], "hospital": []}
    for r in t:
        cat, name, conf = r["basic_category"], (r["names"] or {}).get("primary") or "", r["confidence"] or 0
        if cat == "fire_station" and re.search(r"fire (station|department|dept)|hfd station", name, re.I) and "arson" not in name.lower() and conf >= 0.6:
            kind = "fire"
        elif cat == "police_station" and re.search(r"police|sheriff|constable|patrol|hpd", name, re.I) and conf >= 0.6 and not re.search(NOT_POLICE, name, re.I):
            kind = "police"
        elif cat in ("emergency_department", "hospital", "general_hospital") and re.search(r"hospital|medical center|emergency", name, re.I) and conf >= 0.9 and not re.search(NOT_HOSPITAL, name, re.I):
            kind = "hospital"
        else:
            continue
        g = shapely.from_wkb(r["geometry"])
        x, y = proj(g.x, g.y)
        if not (X0 <= x <= X1 and Y0 <= y <= Y1):
            continue
        out[kind].append((conf, name, x, y))
    res = []
    spacing = {"fire": 350, "police": 400, "hospital": 700}
    for kind, items in out.items():
        items.sort(key=lambda r: -r[0])
        kept, numbers = [], set()
        for conf, name, x, y in items:
            num = re.search(r"(\d+)\s*$", name)
            if kind == "fire" and num and num.group(1) in numbers:
                continue
            if any((x - kx) ** 2 + (y - ky) ** 2 < spacing[kind] ** 2 for _, _, kx, ky in kept):
                continue
            if num and kind == "fire":
                numbers.add(num.group(1))
            kept.append((conf, name, x, y))
        for _, name, x, y in kept:
            node, d = snap.nearest(x, y)
            if node >= 0:
                name = re.sub(r"^HFD Station", "Houston Fire Station", name)
                res.append({"kind": kind, "name": name, "x": round(x), "y": round(y), "node": node})
    return res


def build_addresses(snap, k=20000):
    t = pq.read_table(RAW / "addresses.parquet").to_pylist()
    rng = random.Random(2017)
    rng.shuffle(t)
    streets, sidx, out, seen = [], {}, [], set()
    for r in t:
        if not r["number"] or not r["street"] or not r["number"].isdigit():
            continue
        g = shapely.from_wkb(r["geometry"])
        x, y = proj(g.x, g.y)
        if not (X0 + 200 <= x <= X1 - 200 and Y0 + 200 <= y <= Y1 - 200):
            continue
        street = clean_name(r["street"])
        key = (r["number"], street)
        if key in seen:
            continue
        node, d = snap.nearest(x, y, 150)
        if node < 0:
            continue
        seen.add(key)
        if street not in sidx:
            sidx[street] = len(streets)
            streets.append(street)
        out.extend([round(x), round(y), int(r["number"]), sidx[street], node])
        if len(out) // 5 >= k:
            break
    return streets, out


def b64(a):
    return base64.b64encode(a.tobytes()).decode()


def main():
    nodes, edges, names = build_roads()
    print(f"roads: {len(nodes)} nodes, {len(edges)} edges, {len(names)} street names")
    snap = Snapper(nodes)
    stations = build_stations(snap)
    print("stations:", collections.Counter(s["kind"] for s in stations))
    streets, addrs = build_addresses(snap, ARGS.addresses)
    print(f"addresses: {len(addrs) // 5}")
    keep = {s["node"] for s in stations} | set(addrs[4::5])
    nodes, edges, remap = contract(nodes, edges, keep)
    for s in stations:
        s["node"] = remap[s["node"]]
    for i in range(4, len(addrs), 5):
        addrs[i] = remap[addrs[i]]
    print(f"contracted: {len(nodes)} nodes, {len(edges)} edges")
    flat, shapes = encode_edges(edges)
    elev = build_terrain()
    drain, water = build_water()
    print(f"terrain {GW}x{GH} @ {CELL} m, elevation {elev.min():.1f}..{elev.max():.1f} m, drainage cells {int(drain.sum())}")
    city = {
        "name": ARGS.name,
        "origin": [LON0, LAT0],
        "scale": [KX, KY],
        "bounds": [round(X0), round(Y0), round(X1), round(Y1)],
        "roadClasses": ROAD_CLASSES,
        "nodes": [c for xy in nodes for c in (round(xy[0]), round(xy[1]))],
        "edges": flat,  # road class in the low 4 bits of the class field, bridge/tunnel flags above
        "shapes": shapes,
        "streetNames": names,
        "stations": stations,
        "addrStreets": streets,
        "addresses": addrs,
        "grid": {"x0": round(X0), "y0": round(Y0), "cell": CELL, "w": GW, "h": GH,
                 "elevDm": b64(np.round(elev * 10).astype("<i2")), "drain": b64(drain)},
        "water": water,
        "sources": [
            "Overture Maps Foundation release 2026-09-23.1 (transportation, places, addresses, base/water); includes OpenStreetMap data (ODbL)",
            "AWS Open Data Terrain Tiles (Mapzen terrarium), USGS 3DEP / SRTM derived",
        ],
    }
    OUT.write_text(json.dumps(city, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
