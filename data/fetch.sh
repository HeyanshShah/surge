#!/usr/bin/env bash
# Downloads the raw real-world inputs for one city into a raw/ folder:
#   Overture Maps (roads, places, addresses, water) from the public S3 bucket, anonymous access.
#   Terrain elevation (Terrarium tiles, AWS Open Data "Terrain Tiles") covering the same box.
#
#   bash data/fetch.sh                                         central Houston into data/raw
#   bash data/fetch.sh -97.80,30.22,-97.68,30.32 data/raw-austin   any box (west,south,east,north) in the US
#
# Then: python3 data/build.py --bbox=<same box> --raw <same folder> --name "<City, ST>" --out data/<city>.json
set -euo pipefail
cd "$(dirname "$0")"
BBOX="${1:--95.56,29.62,-95.30,29.82}"
RAW="${2:-raw}"
mkdir -p "$RAW/dem"
python3 fetch_overture.py transportation segment "$RAW/segments.parquet" id,geometry,class,subtype,names,connectors,road_flags "$BBOX"
python3 fetch_overture.py places place "$RAW/places.parquet" id,geometry,names,basic_category,confidence "$BBOX"
python3 fetch_overture.py addresses address "$RAW/addresses.parquet" id,geometry,number,street,postcode "$BBOX"
python3 fetch_overture.py base water "$RAW/water.parquet" id,geometry,class,subtype,names "$BBOX"
# zoom-13 terrain tiles covering the box
read -r X0 X1 Y0 Y1 < <(python3 -c "
import math, sys
w, s, e, n = map(float, '$BBOX'.split(','))
z = 2 ** 13
tx = lambda lon: int((lon + 180) / 360 * z)
ty = lambda lat: int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * z)
print(tx(w), tx(e), ty(n), ty(s))")
for x in $(seq "$X0" "$X1"); do
  for y in $(seq "$Y0" "$Y1"); do
    curl -sf -o "$RAW/dem/13_${x}_${y}.png" "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/$x/$y.png"
  done
done
echo "raw data ready in data/$RAW"
