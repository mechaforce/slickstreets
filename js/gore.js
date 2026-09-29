// Gore chunks are real, movable little bodies rather than decals, because the
// whole point is that you can plough through a pile and shove it aside.
//
// Cost is kept down by parking settled chunks: once a chunk stops moving it
// is skipped entirely until the car (or another chunk) disturbs it again.

import { SpatialHash } from './spatialhash.js';
import { mulberry32, rr, clamp, TAU } from './util.js';
import { CAR_LENGTH, CAR_WIDTH } from './car.js';

export const MAX_CHUNKS = 4600;

export const MEAT = 0;
export const BONE = 1;
export const CHAR = 2;

export class GoreField {
  constructor(seed = 1) {
    this.rng = mulberry32((seed * 40503) >>> 0);
    this.hash = new SpatialHash(28);
    this.chunks = new Array(MAX_CHUNKS);
    for (let i = 0; i < MAX_CHUNKS; i++) {
      this.chunks[i] = {
        live: false, x: 0, y: 0, vx: 0, vy: 0, r: 5, rot: 0, spin: 0,
        type: MEAT, tone: 0, shape: 0, moving: false, age: 0,
      };
    }
    this.head = 0;      // ring-buffer cursor: oldest gore is recycled first
    this.live = 0;
    /** Splats waiting to be baked into the renderer's decal layer. */
    this.splats = [];
    this._q = [];
  }

  reset() {
    for (const c of this.chunks) c.live = false;
    this.head = 0;
    this.live = 0;
    this.splats.length = 0;
  }

  _next() {
    const c = this.chunks[this.head];
    this.head = (this.head + 1) % MAX_CHUNKS;
    if (!c.live) this.live++;
    c.live = true;
    return c;
  }

  /**
   * Burst one enemy into chunks, thrown along the direction it was hit from.
   * `power` is roughly the car's speed - faster hits spray further.
   */
  burst(x, y, dirx, diry, power, kind, amount) {
    const rng = this.rng;
    const spread = clamp(power / 260, 0.25, 1.6);
    for (let i = 0; i < amount; i++) {
      const c = this._next();
      const a = Math.atan2(diry, dirx) + rr(rng, -0.9, 0.9);
      const sp = rr(rng, 40, 240) * spread;
      c.x = x + rr(rng, -6, 6);
      c.y = y + rr(rng, -6, 6);
      c.vx = Math.cos(a) * sp;
      c.vy = Math.sin(a) * sp;
      c.r = kind === MEAT ? rr(rng, 5, 13) : rr(rng, 3.2, 7);
      c.rot = rr(rng, 0, TAU);
      c.spin = rr(rng, -6, 6);
      c.type = kind;
      c.tone = rng();
      c.shape = Math.floor(rng() * 4);
      c.moving = true;
      c.age = 0;
    }
    if (this.splats.length > 512) this.splats.shift();
    this.splats.push({
      x, y,
      r: (kind === MEAT ? 40 : 25) + power * 0.07,
      tone: this.rng(),
      kind,
      dirx, diry,
      power,
    });
  }

  /** Rebuild the hash and step every chunk that is still in motion. */
  update(dt) {
    this.hash.clear();
    const arr = this.chunks;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (!c.live) continue;
      this.hash.insert(c.x, c.y, c);
      if (!c.moving) continue;

      c.age += dt;
      const fr = Math.exp(-7.5 * dt);
      c.vx *= fr;
      c.vy *= fr;
      c.rot += c.spin * dt;
      c.spin *= fr;
      c.x += c.vx * dt;
      c.y += c.vy * dt;

      if (c.vx * c.vx + c.vy * c.vy < 36) {
        c.vx = 0;
        c.vy = 0;
        c.spin = 0;
        c.moving = false;
      }
    }

    // Moving chunks shoulder settled ones aside, so a shoved pile spreads
    // outwards instead of everything piling onto one point.
    const q = this._q;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (!c.live || !c.moving) continue;
      this.hash.query(c.x, c.y, c.r * 2, q);
      let n = 0;
      for (let j = 0; j < q.length && n < 6; j++) {
        const o = q[j];
        if (o === c || !o.live) continue;
        const dx = o.x - c.x;
        const dy = o.y - c.y;
        const d2 = dx * dx + dy * dy;
        const min = (c.r + o.r) * 0.8;
        if (d2 > min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) / min;
        o.x += (dx / d) * push * 1.4;
        o.y += (dy / d) * push * 1.4;
        o.vx += (dx / d) * push * 26;
        o.vy += (dy / d) * push * 26;
        o.moving = true;
        n++;
      }
    }
  }

  /**
   * Shove chunks out of the car's footprint and report how clogged the car is.
   * Returns 0..1 gore drag.
   */
  plough(car, widthScale = 1) {
    const cos = Math.cos(car.ang);
    const sin = Math.sin(car.ang);
    const speed = Math.abs(car.speed);
    const reach = CAR_LENGTH * 0.7;
    const q = this.hash.query(car.x, car.y, reach + 14 + CAR_WIDTH * (widthScale - 1), this._q);
    let touching = 0;

    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (!c.live) continue;
      const dx = c.x - car.x;
      const dy = c.y - car.y;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      const hx = CAR_LENGTH * 0.5 + c.r;
      const hy = CAR_WIDTH * 0.5 * widthScale + c.r;
      if (Math.abs(lx) > hx || Math.abs(ly) > hy) continue;

      touching++;
      // Eject sideways: that is what leaves clean wheel tracks through a pile.
      const side = ly >= 0 ? 1 : -1;
      const out = hy - Math.abs(ly) + 0.5;
      const px = -sin * side;
      const py = cos * side;
      c.x += px * out;
      c.y += py * out;
      const force = 60 + speed * 0.55;
      c.vx += px * force + cos * car.speed * 0.06;
      c.vy += py * force + sin * car.speed * 0.06;
      c.spin += (this.rng() - 0.5) * 12;
      c.moving = true;
    }
    return clamp(touching / 26, 0, 1);
  }
}
