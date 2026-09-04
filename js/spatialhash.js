// Uniform grid used for the thousands of enemies and gore chunks.
// Buckets are recycled between frames so a full rebuild allocates nothing.

const BIAS = 4096;
const STRIDE = 8192;

export class SpatialHash {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
    this.buckets = new Map();
    this.used = [];
  }

  clear() {
    for (let i = 0; i < this.used.length; i++) this.used[i].length = 0;
    this.used.length = 0;
  }

  _key(cx, cy) {
    return (cx + BIAS) * STRIDE + (cy + BIAS);
  }

  insert(x, y, item) {
    const cx = Math.floor(x * this.inv);
    const cy = Math.floor(y * this.inv);
    const k = this._key(cx, cy);
    let b = this.buckets.get(k);
    if (b === undefined) {
      b = [];
      this.buckets.set(k, b);
    }
    if (b.length === 0) this.used.push(b);
    b.push(item);
  }

  /**
   * Collect every item stored in cells overlapping the circle (x, y, r).
   * Results are a superset of the circle - callers do the exact test.
   */
  query(x, y, r, out) {
    out.length = 0;
    const x0 = Math.floor((x - r) * this.inv);
    const x1 = Math.floor((x + r) * this.inv);
    const y0 = Math.floor((y - r) * this.inv);
    const y1 = Math.floor((y + r) * this.inv);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const b = this.buckets.get(this._key(cx, cy));
        if (b === undefined) continue;
        for (let i = 0; i < b.length; i++) out.push(b[i]);
      }
    }
    return out;
  }

  /** Visit items in cells overlapping an axis-aligned rect. */
  forEachInRect(x, y, w, h, fn) {
    const x0 = Math.floor(x * this.inv);
    const x1 = Math.floor((x + w) * this.inv);
    const y0 = Math.floor(y * this.inv);
    const y1 = Math.floor((y + h) * this.inv);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const b = this.buckets.get(this._key(cx, cy));
        if (b === undefined) continue;
        for (let i = 0; i < b.length; i++) fn(b[i]);
      }
    }
  }
}
