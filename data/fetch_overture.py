"""Pull one Overture Maps theme/type for the Houston study area straight from the public S3 bucket.

usage: python3 fetch_overture.py <theme> <type> <out.parquet> <comma,separated,columns>
Row groups are pruned by their bbox statistics, so only a few MB are actually transferred.
"""
import sys
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as fs
import pyarrow.parquet as pq

RELEASE = "2026-09-23.1"
W, S, E, N = -95.56, 29.62, -95.30, 29.82  # central Houston: downtown, Medical Center, Meyerland, Bellaire, Heights

theme, typ, out, cols = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(",")
s3 = fs.S3FileSystem(anonymous=True, region="us-west-2")
d = ds.dataset(f"overturemaps-us-west-2/release/{RELEASE}/theme={theme}/type={typ}/", filesystem=s3, format="parquet")
inside = (pc.field("bbox", "xmin") < E) & (pc.field("bbox", "xmax") > W) & (pc.field("bbox", "ymin") < N) & (pc.field("bbox", "ymax") > S)
t = d.to_table(filter=inside, columns=cols)
pq.write_table(t, out)
print(f"{theme}/{typ}: {t.num_rows} rows -> {out}")
