#!/usr/bin/env bash
# Downloads the raw real-world inputs for the Houston scenario into data/raw/.
#   Overture Maps (roads, places, addresses, water) from the public S3 bucket, anonymous access.
#   Terrain elevation (Terrarium tiles, AWS Open Data "Terrain Tiles") for the same area.
# Then run: python3 data/build.py
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw/dem
python3 fetch_overture.py transportation segment raw/segments.parquet id,geometry,class,subtype,names,connectors
python3 fetch_overture.py places place raw/places.parquet id,geometry,names,basic_category,confidence
python3 fetch_overture.py addresses address raw/addresses.parquet id,geometry,number,street,postcode
python3 fetch_overture.py base water raw/water.parquet id,geometry,class,subtype,names
for x in $(seq 1921 1927); do
  for y in $(seq 3384 3389); do
    curl -sf -o "raw/dem/13_${x}_${y}.png" "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/$x/$y.png"
  done
done
echo "raw data ready in data/raw"
