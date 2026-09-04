// Vehicle upgrades scattered across the whole city, sitting out on the road
// waiting to be driven over. Each one is a timed modification to the car
// rather than a permanent one, so a run has a rhythm to it: you spend a while
// hunting for the next crate, then a while being briefly unstoppable.

import { mulberry32, rr, clamp, TAU } from './util.js';
import { CELL, ROAD, isBlocked } from './city.js';

export const WIRE = 0;
export const WHEELS = 1;
export const FLAME = 2;

export const PICKUP_KINDS = [
  {
    name: 'BARBED WIRE',
    blurb: 'they shred themselves on the bodywork',
    colour: '#9ad9e8',
    duration: 26,
  },
  {
    name: 'BIG WHEELS',
    blurb: 'a much wider path through them',
    colour: '#e8c04a',
    duration: 26,
  },
  {
    name: 'FLAMETHROWER',
    blurb: 'clears the road ahead every few seconds',
    colour: '#ff6a2f',
    duration: 24,
  },
];

export const PICKUP_RADIUS = 17;
const COLLECT_RADIUS = 34;
/** Roughly one crate per this many blocks, spread over the whole map. */
const BLOCK_CHANCE = 0.2;
/** A replacement is placed at least this far away, so you have to go find it. */
const RESPAWN_MIN_DIST = 1600;

export class PickupField {
  constructor(city, seed = 1) {
    this.city = city;
    this.rng = mulberry32((seed * 22695477) >>> 0);
    this.items = [];
    this.grid = new Map();
    this._q = [];
    this._scatter();
  }

  _key(x, y) {
    return Math.floor(x / CELL) * 8192 + Math.floor(y / CELL);
  }

  _index(p) {
    const k = this._key(p.x, p.y);
    let list = this.grid.get(k);
    if (list === undefined) this.grid.set(k, (list = []));
    list.push(p);
  }

  _deindex(p) {
    const list = this.grid.get(this._key(p.x, p.y));
    if (list === undefined) return;
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1);
  }

  /** A point out on the tarmac, clear of buildings. */
  _roadPoint(out) {
    const { city, rng } = this;
    for (let attempt = 0; attempt < 12; attempt++) {
      const cx = Math.floor(rng() * city.cols);
      const cy = Math.floor(rng() * city.rows);
      // Sit on one of the two streets bounding this block.
      const alongX = rng() < 0.5;
      const lane = rr(rng, -ROAD * 0.28, ROAD * 0.28);
      const x = alongX ? cx * CELL + rr(rng, -CELL * 0.4, CELL * 0.4) : cx * CELL + lane;
      const y = alongX ? cy * CELL + lane : cy * CELL + rr(rng, -CELL * 0.4, CELL * 0.4);
      if (x < ROAD || y < ROAD || x > city.width - ROAD || y > city.height - ROAD) continue;
      if (isBlocked(city, x, y, PICKUP_RADIUS + 6)) continue;
      out.x = x;
      out.y = y;
      return true;
    }
    return false;
  }

  _make(x, y, kind) {
    const p = { x, y, kind, alive: true, phase: this.rng() * TAU };
    this.items.push(p);
    this._index(p);
    return p;
  }

  _scatter() {
    const { city, rng } = this;
    const want = Math.round(city.cols * city.rows * BLOCK_CHANCE);
    const at = { x: 0, y: 0 };
    for (let i = 0; i < want; i++) {
      if (!this._roadPoint(at)) continue;
      this._make(at.x, at.y, Math.floor(rng() * PICKUP_KINDS.length));
    }
  }

  /** Keep the map stocked: a collected crate reappears somewhere far off. */
  _replace(awayFrom) {
    const at = { x: 0, y: 0 };
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!this._roadPoint(at)) continue;
      const dx = at.x - awayFrom.x;
      const dy = at.y - awayFrom.y;
      if (dx * dx + dy * dy < RESPAWN_MIN_DIST * RESPAWN_MIN_DIST) continue;
      this._make(at.x, at.y, Math.floor(this.rng() * PICKUP_KINDS.length));
      return true;
    }
    return false;
  }

  get count() {
    return this.items.length;
  }

  /** Crates in the cells around a point, for drawing and for collection. */
  nearby(x, y, r, out) {
    out.length = 0;
    const x0 = Math.floor((x - r) / CELL);
    const x1 = Math.floor((x + r) / CELL);
    const y0 = Math.floor((y - r) / CELL);
    const y1 = Math.floor((y + r) / CELL);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.grid.get(cx * 8192 + cy);
        if (list === undefined) continue;
        for (let i = 0; i < list.length; i++) out.push(list[i]);
      }
    }
    return out;
  }

  /**
   * Bob the nearby crates and hand back whatever the car just drove over.
   * Returns an array of collected kinds (usually empty).
   */
  update(dt, car, collected) {
    collected.length = 0;
    const near = this.nearby(car.x, car.y, CELL, this._q);
    for (let i = 0; i < near.length; i++) {
      const p = near[i];
      if (!p.alive) continue;
      p.phase += dt * 2.2;
      const dx = p.x - car.x;
      const dy = p.y - car.y;
      if (dx * dx + dy * dy > COLLECT_RADIUS * COLLECT_RADIUS) continue;

      p.alive = false;
      this._deindex(p);
      const idx = this.items.indexOf(p);
      if (idx >= 0) this.items.splice(idx, 1);
      collected.push(p.kind);
      this._replace(car);
    }
    return collected;
  }
}
