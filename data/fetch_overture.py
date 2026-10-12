"""Pull one Overture Maps theme/type for a study area straight from the public S3 bucket.

usage: python3 fetch_overture.py <theme> <type> <out.parquet> <comma,separated,columns> [west,south,east,north]
Row groups are pruned by their bbox statistics, so only a few MB are actually transferred.
"""
import sys
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as fs
import pyarrow.parquet as pq

RELEASE = "2026-09-23.1"
# default: central Houston (downtown, Medical Center, Meyerland, Bellaire, Heights)
BBOX = sys.argv[5] if len(sys.argv) > 5 else "-95.56,29.62,-95.30,29.82"
W, S, E, N = (float(v) for v in BBOX.split(","))

theme, typ, out, cols = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(",")
s3 = fs.S3FileSystem(anonymous=True, region="us-west-2")
d = ds.dataset(f"overturemaps-us-west-2/release/{RELEASE}/theme={theme}/type={typ}/", filesystem=s3, format="parquet")
inside = (pc.field("bbox", "xmin") < E) & (pc.field("bbox", "xmax") > W) & (pc.field("bbox", "ymin") < N) & (pc.field("bbox", "ymax") > S)
t = d.to_table(filter=inside, columns=cols)
pq.write_table(t, out)
print(f"{theme}/{typ}: {t.num_rows} rows -> {out}")
