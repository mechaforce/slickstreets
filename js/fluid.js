// A light 2D fluid for the blood: semi-Lagrangian advection with a few
// Gauss-Seidel pressure iterations, in the style of Stam's stable fluids.
//
// It only covers a window of the city around the car. Blood that leaves the
// window is gone from the simulation, which is fine - by then it has already
// been baked into the permanent stains the renderer keeps. So this layer is
// the *wet* blood: it pools, it gets dragged and thrown by the tyres, and it
// is what makes the road slippery.
//
// No DOM in here; the renderer reads the grid out and draws it.

export const CELL_SIZE = 18;
export const GRID = 128;            // 128 * 18 = 2304px of city
const SLACK = 8;                    // cells of drift before the window moves
const PRESSURE_ITERS = 4;

/** Velocities are stored in cells per second, densities in "how bloody". */
export class BloodField {
  constructor(cells = GRID, cellSize = CELL_SIZE) {
    this.n = cells;
    this.cs = cellSize;
    this.size = cells * cells;
    this.d = new Float32Array(this.size);
    this.u = new Float32Array(this.size);
    this.v = new Float32Array(this.size);
    this.d0 = new Float32Array(this.size);
    this.u0 = new Float32Array(this.size);
    this.v0 = new Float32Array(this.size);
    this.p = new Float32Array(this.size);
    this.div = new Float32Array(this.size);
    this.tmp = new Float32Array(this.size);
    this.ox = 0;
    this.oy = 0;
    this.wet = 0; // total density, so callers can skip work on a clean road
    // Only the part of the grid that actually has blood in it is simulated;
    // on a clean road that is nothing at all.
    this.bi0 = 0; this.bi1 = -1; this.bj0 = 0; this.bj1 = -1;
  }

  get empty() { return this.bi1 < this.bi0; }

  /** Grow the simulated region to include a cell range. */
  _touch(i0, i1, j0, j1) {
    const n = this.n;
    if (i1 < 0 || j1 < 0 || i0 > n - 1 || j0 > n - 1) return;
    if (this.empty) {
      this.bi0 = Math.max(0, i0); this.bi1 = Math.min(n - 1, i1);
      this.bj0 = Math.max(0, j0); this.bj1 = Math.min(n - 1, j1);
      return;
    }
    if (i0 < this.bi0) this.bi0 = Math.max(0, i0);
    if (i1 > this.bi1) this.bi1 = Math.min(n - 1, i1);
    if (j0 < this.bj0) this.bj0 = Math.max(0, j0);
    if (j1 > this.bj1) this.bj1 = Math.min(n - 1, j1);
  }

  reset() {
    this.d.fill(0);
    this.u.fill(0);
    this.v.fill(0);
    this.wet = 0;
    this.bi0 = 0; this.bi1 = -1; this.bj0 = 0; this.bj1 = -1;
  }

  get width() { return this.n * this.cs; }

  // ---- window ------------------------------------------------------------

  /** Keep the simulated window centred on a point, moving it in whole cells. */
  anchor(x, y) {
    const half = this.n * 0.5 * this.cs;
    const di = Math.round((x - half - this.ox) / this.cs);
    const dj = Math.round((y - half - this.oy) / this.cs);
    if (Math.abs(di) < SLACK && Math.abs(dj) < SLACK) return;
    if (Math.abs(di) >= this.n || Math.abs(dj) >= this.n) {
      // Teleported somewhere else entirely: nothing to carry over.
      this.reset();
    } else {
      this._shift(this.d, di, dj);
      this._shift(this.u, di, dj);
      this._shift(this.v, di, dj);
      if (!this.empty) {
        const n = this.n;
        this.bi0 = Math.max(0, this.bi0 - di);
        this.bi1 = Math.min(n - 1, this.bi1 - di);
        this.bj0 = Math.max(0, this.bj0 - dj);
        this.bj1 = Math.min(n - 1, this.bj1 - dj);
        if (this.bi1 < this.bi0 || this.bj1 < this.bj0) {
          this.bi1 = -1; this.bj1 = -1;
        }
      }
    }
    this.ox += di * this.cs;
    this.oy += dj * this.cs;
  }

  _shift(f, di, dj) {
    const n = this.n;
    const tmp = this.tmp;
    tmp.set(f);
    f.fill(0);
    for (let j = 0; j < n; j++) {
      const sj = j + dj;
      if (sj < 0 || sj >= n) continue;
      const row = j * n;
      const srow = sj * n;
      for (let i = 0; i < n; i++) {
        const si = i + di;
        if (si < 0 || si >= n) continue;
        f[i + row] = tmp[si + srow];
      }
    }
  }

  // ---- reading and writing ------------------------------------------------

  /** Grid coordinate of a world point (may be outside the window). */
  gx(x) { return (x - this.ox) / this.cs; }
  gy(y) { return (y - this.oy) / this.cs; }

  /** Bilinear density at a world point. 0 on dry road. */
  sample(x, y) {
    const n = this.n;
    const fx = this.gx(x);
    const fy = this.gy(y);
    if (fx < 0 || fy < 0 || fx >= n - 1 || fy >= n - 1) return 0;
    const i = fx | 0;
    const j = fy | 0;
    const sx = fx - i;
    const sy = fy - j;
    const k = i + j * n;
    const d = this.d;
    return (d[k] * (1 - sx) + d[k + 1] * sx) * (1 - sy)
         + (d[k + n] * (1 - sx) + d[k + n + 1] * sx) * sy;
  }

  /** Pour blood in, optionally throwing it in a direction. */
  add(x, y, amount, wvx = 0, wvy = 0, radius = 20) {
    const n = this.n;
    const cs = this.cs;
    const fx = this.gx(x);
    const fy = this.gy(y);
    const r = Math.max(0.8, radius / cs);
    const i0 = Math.max(0, Math.floor(fx - r));
    const i1 = Math.min(n - 1, Math.ceil(fx + r));
    const j0 = Math.max(0, Math.floor(fy - r));
    const j1 = Math.min(n - 1, Math.ceil(fy + r));
    if (i1 < i0 || j1 < j0) return;
    this._touch(i0, i1, j0, j1);

    const vx = wvx / cs;
    const vy = wvy / cs;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const dy = j - fy;
      for (let i = i0; i <= i1; i++) {
        const dx = i - fx;
        const q = (dx * dx + dy * dy) / r2;
        if (q > 1) continue;
        const w = 1 - q;
        const k = i + j * n;
        this.d[k] += amount * w;
        this.u[k] += vx * w;
        this.v[k] += vy * w;
      }
    }
  }

  /** Drag whatever is here, without adding any more of it. */
  addVelocity(x, y, wvx, wvy, radius = 20) {
    const n = this.n;
    const cs = this.cs;
    const fx = this.gx(x);
    const fy = this.gy(y);
    const r = Math.max(0.8, radius / cs);
    const i0 = Math.max(0, Math.floor(fx - r));
    const i1 = Math.min(n - 1, Math.ceil(fx + r));
    const j0 = Math.max(0, Math.floor(fy - r));
    const j1 = Math.min(n - 1, Math.ceil(fy + r));
    if (i1 < i0 || j1 < j0) return;
    this._touch(i0, i1, j0, j1);

    const vx = wvx / cs;
    const vy = wvy / cs;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const dy = j - fy;
      for (let i = i0; i <= i1; i++) {
        const dx = i - fx;
        const q = (dx * dx + dy * dy) / r2;
        if (q > 1) continue;
        const w = 1 - q;
        const k = i + j * n;
        this.u[k] += vx * w;
        this.v[k] += vy * w;
      }
    }
  }

  /** Scoop blood up off the road - what the tyres pick up and carry away. */
  take(x, y, fraction, radius = 16) {
    const n = this.n;
    const fx = this.gx(x);
    const fy = this.gy(y);
    const r = Math.max(0.8, radius / this.cs);
    const i0 = Math.max(0, Math.floor(fx - r));
    const i1 = Math.min(n - 1, Math.ceil(fx + r));
    const j0 = Math.max(0, Math.floor(fy - r));
    const j1 = Math.min(n - 1, Math.ceil(fy + r));
    let taken = 0;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const dy = j - fy;
      for (let i = i0; i <= i1; i++) {
        const dx = i - fx;
        const q = (dx * dx + dy * dy) / r2;
        if (q > 1) continue;
        const k = i + j * n;
        const got = this.d[k] * fraction * (1 - q);
        this.d[k] -= got;
        taken += got;
      }
    }
    return taken;
  }

  // ---- the simulation ------------------------------------------------------

  _advect(dst, src, dt) {
    const n = this.n;
    const u = this.u;
    const v = this.v;
    const max = n - 1.001;
    for (let j = this.bj0; j <= this.bj1; j++) {
      const row = j * n;
      for (let i = this.bi0; i <= this.bi1; i++) {
        const k = i + row;
        let x = i - dt * u[k];
        let y = j - dt * v[k];
        if (x < 0) x = 0; else if (x > max) x = max;
        if (y < 0) y = 0; else if (y > max) y = max;
        const i0 = x | 0;
        const j0 = y | 0;
        const sx = x - i0;
        const sy = y - j0;
        const a = i0 + j0 * n;
        dst[k] = (src[a] * (1 - sx) + src[a + 1] * sx) * (1 - sy)
               + (src[a + n] * (1 - sx) + src[a + n + 1] * sx) * sy;
      }
    }
  }

  /** Push the velocity field toward divergence-free - this is what swirls. */
  _project() {
    const n = this.n;
    const u = this.u;
    const v = this.v;
    const p = this.p;
    const div = this.div;
    const i0 = Math.max(1, this.bi0);
    const i1 = Math.min(n - 2, this.bi1);
    const j0 = Math.max(1, this.bj0);
    const j1 = Math.min(n - 2, this.bj1);

    for (let j = j0; j <= j1; j++) {
      const row = j * n;
      for (let i = i0; i <= i1; i++) {
        const k = i + row;
        div[k] = -0.5 * (u[k + 1] - u[k - 1] + v[k + n] - v[k - n]);
        p[k] = 0;
      }
    }
    for (let it = 0; it < PRESSURE_ITERS; it++) {
      for (let j = j0; j <= j1; j++) {
        const row = j * n;
        for (let i = i0; i <= i1; i++) {
          const k = i + row;
          p[k] = (div[k] + p[k - 1] + p[k + 1] + p[k - n] + p[k + n]) * 0.25;
        }
      }
    }
    for (let j = j0; j <= j1; j++) {
      const row = j * n;
      for (let i = i0; i <= i1; i++) {
        const k = i + row;
        u[k] -= 0.5 * (p[k + 1] - p[k - 1]);
        v[k] -= 0.5 * (p[k + n] - p[k - n]);
      }
    }
  }

  /** A touch of spreading, so pools have soft edges rather than hard cells. */
  _diffuse(amount) {
    const n = this.n;
    const d = this.d;
    const t = this.tmp;
    t.set(d);
    const keep = 1 - amount;
    const i0 = Math.max(1, this.bi0);
    const i1 = Math.min(n - 2, this.bi1);
    const j0 = Math.max(1, this.bj0);
    const j1 = Math.min(n - 2, this.bj1);
    for (let j = j0; j <= j1; j++) {
      const row = j * n;
      for (let i = i0; i <= i1; i++) {
        const k = i + row;
        d[k] = t[k] * keep
          + (t[k - 1] + t[k + 1] + t[k - n] + t[k + n]) * (amount * 0.25);
      }
    }
  }

  step(dt) {
    if (dt <= 0 || this.empty) return;
    const damp = Math.exp(-3.4 * dt);   // blood is viscous; it stops quickly
    const dry = Math.exp(-0.085 * dt);  // and slowly soaks into the tarmac

    // Room for this step's spreading and advection to move into.
    this._touch(this.bi0 - 2, this.bi1 + 2, this.bj0 - 2, this.bj1 + 2);

    const n = this.n;
    const u = this.u;
    const v = this.v;
    for (let j = this.bj0; j <= this.bj1; j++) {
      const row = j * n;
      for (let i = this.bi0; i <= this.bi1; i++) {
        u[i + row] *= damp;
        v[i + row] *= damp;
      }
    }

    // Self-advection then projection: the swirl in the smear comes from here.
    this.u0.set(u);
    this.v0.set(v);
    this._advect(u, this.u0, dt);
    this._advect(v, this.v0, dt);
    this._project();

    this.d0.set(this.d);
    this._advect(this.d, this.d0, dt);
    this._diffuse(Math.min(0.5, 1.6 * dt));

    // Dry it off, and shrink the active region back around what is left.
    const d = this.d;
    let total = 0;
    let ni0 = n;
    let ni1 = -1;
    let nj0 = n;
    let nj1 = -1;
    for (let j = this.bj0; j <= this.bj1; j++) {
      const row = j * n;
      for (let i = this.bi0; i <= this.bi1; i++) {
        const k = i + row;
        const val = d[k] * dry;
        if (val < 0.0008) {
          d[k] = 0;
          u[k] = 0;
          v[k] = 0;
          continue;
        }
        d[k] = val;
        total += val;
        if (i < ni0) ni0 = i;
        if (i > ni1) ni1 = i;
        if (j < nj0) nj0 = j;
        if (j > nj1) nj1 = j;
      }
    }
    this.wet = total;
    this.bi0 = ni0; this.bi1 = ni1;
    this.bj0 = nj0; this.bj1 = nj1;
  }
}
