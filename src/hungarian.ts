/**
 * Optimal assignment (Kuhn-Munkres / Hungarian algorithm, O(n^2 m) with potentials).
 * Maximizes total value over a rows x cols matrix; entries of -Infinity are forbidden pairs.
 * Returns, for each row, the assigned column or -1.
 */
export function assignMax(value: number[][]): number[] {
  const rows = value.length;
  if (rows === 0) return [];
  const cols = value[0].length;
  // pad to square and convert to a min-cost problem
  const n = rows + cols; // every row and column can fall back to a dummy partner
  let maxV = 0;
  for (const r of value) for (const v of r) if (Number.isFinite(v) && v > maxV) maxV = v;
  const BIG = (maxV + 1) * 1e6;
  const cost = (i: number, j: number) => {
    if (i >= rows || j >= cols) return maxV; // dummy row/col: cost of "no assignment"
    const v = value[i][j];
    return Number.isFinite(v) ? maxV - v : BIG;
  };
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1); // p[j] = row matched to column j (1-based)
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
