/** Binary min-heap of (key, value) number pairs on growable typed arrays. Used by every shortest-path search, so it avoids allocating per push. */
export class NumHeap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(key: number, val: number): void {
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
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Key of the minimum element. Only valid when size > 0. */
  topKey(): number {
    return this.keys[0];
  }

  /** Removes the minimum element and returns its value. Only valid when size > 0. */
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    const k = keys[n];
    const v = vals[n];
    let i = 0;
    for (;;) {
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
}
