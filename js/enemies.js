// The horde. Thousands of agents, so everything here is written for the
// common case: pooled objects, a rebuilt spatial hash, capped neighbour scans
// and a cheap update tier for anything far off screen.

import { SpatialHash } from './spatialhash.js';
import { isBlocked, resolveCircle } from './city.js';
import { mulberry32, rr, clamp, TAU } from './util.js';

export const ZOMBIE = 0;
export const SKELETON = 1;

/**
 * Zombies are heavy and slow: they clog the car and are the source of the
 * thick gore. Skeletons are quick and brittle - they die at lower speed but
 * they get to you first and claw harder.
 */
export const KINDS = [
  { name: 'zombie',   radius: 9,   speed: [42, 74],  killSpeed: 88, mass: 1.0, damage: 3.2, drag: 1.0, gore: 6 },
  { name: 'skeleton', radius: 7.5, speed: [86, 128], killSpeed: 52, mass: 0.55, damage: 5.0, drag: 0.6, gore: 3 },
];

const ACTIVE_RADIUS = 1750;   // full-rate AI inside this radius of the car
const DESPAWN_RADIUS = 2900;
const SPAWN_MIN = 820;
const SPAWN_MAX = 1360;
const MAX_ENEMIES = 2600;
const SEPARATION_R = 24;
const MAX_NEIGHBOURS = 10;

export class Swarm {
  constructor(city, seed = 1) {
    this.city = city;
    this.rng = mulberry32((seed * 2654435761) >>> 0);
    this.hash = new SpatialHash(32);
    this.pool = new Array(MAX_ENEMIES);
    this.free = [];
    this.active = [];
    for (let i = 0; i < MAX_ENEMIES; i++) {
      this.pool[i] = {
        i, alive: false, x: 0, y: 0, vx: 0, vy: 0, ang: 0,
        r: 9, kind: ZOMBIE, spd: 50, phase: 0, wob: 0, stun: 0,
      };
      this.free.push(this.pool[i]);
    }
    this._q = [];
    this._hit = { nx: 0, ny: 0, depth: 0 };
    this._tick = 0;
    this.hordeTimer = 6;
  }

  get count() { return this.active.length; }

  reset() {
    for (const e of this.active) e.alive = false;
    this.active.length = 0;
    this.free.length = 0;
    for (let i = 0; i < this.pool.length; i++) this.free.push(this.pool[i]);
    this.hordeTimer = 6;
  }

  spawn(x, y, kind) {
    const e = this.free.pop();
    if (e === undefined) return null;
    const k = KINDS[kind];
    e.alive = true;
    e.x = x;
    e.y = y;
    e.vx = 0;
    e.vy = 0;
    e.kind = kind;
    e.r = k.radius;
    e.spd = rr(this.rng, k.speed[0], k.speed[1]);
    e.ang = rr(this.rng, 0, TAU);
    e.phase = rr(this.rng, 0, TAU);
    e.wob = rr(this.rng, 0.6, 1.6);
    e.stun = 0;
    this.active.push(e);
    return e;
  }

  kill(e) {
    e.alive = false;
    const idx = this.active.indexOf(e);
    if (idx >= 0) {
      this.active[idx] = this.active[this.active.length - 1];
      this.active.pop();
    }
    this.free.push(e);
  }

  /**
   * Find a spawn point on open ground in a ring around the car. Spawns are
   * biased toward `heading` so the street you are driving down is always
   * filling up ahead of you instead of emptying out behind.
   */
  _spawnPoint(tx, ty, out, heading) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = heading !== undefined && this.rng() < 0.72
        ? heading + rr(this.rng, -0.85, 0.85)
        : this.rng() * TAU;
      const d = rr(this.rng, SPAWN_MIN, SPAWN_MAX);
      const x = tx + Math.cos(a) * d;
      const y = ty + Math.sin(a) * d;
      if (x < 40 || y < 40 || x > this.city.width - 40 || y > this.city.height - 40) continue;
      if (isBlocked(this.city, x, y, 12)) continue;
      out.x = x;
      out.y = y;
      return true;
    }
    return false;
  }

  /**
   * `difficulty` is 0..1 and drives both how many of them there are and how
   * many of those are skeletons.
   */
  update(dt, target, difficulty) {
    const city = this.city;
    const rng = this.rng;
    this._tick++;

    // ---- population -------------------------------------------------
    const want = Math.min(MAX_ENEMIES, Math.round(430 + 2100 * difficulty));
    const skelChance = 0.06 + 0.42 * difficulty;
    const p = { x: 0, y: 0 };
    const moving = Math.hypot(target.vx, target.vy) > 70;
    const heading = moving ? Math.atan2(target.vy, target.vx) : undefined;
    let budget = 40;
    while (this.active.length < want && budget-- > 0) {
      if (!this._spawnPoint(target.x, target.y, p, heading)) break;
      this.spawn(p.x, p.y, rng() < skelChance ? SKELETON : ZOMBIE);
    }

    // Occasional tight cluster dumped into the street: a proper wall of them.
    this.hordeTimer -= dt;
    if (this.hordeTimer <= 0) {
      this.hordeTimer = rr(rng, 9, 17) * (1 - 0.4 * difficulty);
      if (this._spawnPoint(target.x, target.y, p, heading)) {
        const n = Math.round(rr(rng, 30, 70) * (0.5 + difficulty));
        for (let i = 0; i < n; i++) {
          const a = rng() * TAU;
          const d = Math.sqrt(rng()) * rr(rng, 60, 190);
          const x = p.x + Math.cos(a) * d;
          const y = p.y + Math.sin(a) * d;
          if (isBlocked(city, x, y, 10)) continue;
          this.spawn(x, y, rng() < skelChance ? SKELETON : ZOMBIE);
        }
      }
    }

    // ---- rebuild the hash -------------------------------------------
    this.hash.clear();
    const act = this.active;
    for (let i = 0; i < act.length; i++) this.hash.insert(act[i].x, act[i].y, act[i]);

    // ---- steering ----------------------------------------------------
    const q = this._q;
    const activeR2 = ACTIVE_RADIUS * ACTIVE_RADIUS;
    const despawn2 = DESPAWN_RADIUS * DESPAWN_RADIUS;
    const slowPhase = this._tick % 6;

    for (let i = act.length - 1; i >= 0; i--) {
      const e = act[i];
      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const d2 = dx * dx + dy * dy;

      if (d2 > despawn2) {
        if (act.length > want * 0.85) this.kill(e);
        continue;
      }

      let step = dt;
      if (d2 > activeR2) {
        // Far away: think once every six frames with a six-times-longer step.
        if (e.i % 6 !== slowPhase) continue;
        step = dt * 6;
      }

      const d = Math.sqrt(d2) || 1;
      const k = KINDS[e.kind];

      let ax = dx / d;
      let ay = dy / d;

      // Shambling wobble so a mass of them does not move as one rigid blob.
      e.phase += step * (2.4 + e.wob);
      const wob = Math.sin(e.phase) * 0.28 * e.wob;
      const wx = ax * Math.cos(wob) - ay * Math.sin(wob);
      const wy = ax * Math.sin(wob) + ay * Math.cos(wob);
      ax = wx;
      ay = wy;

      // Separation - the reason a swarm has a surface instead of a singularity.
      if (d2 < activeR2) {
        this.hash.query(e.x, e.y, SEPARATION_R, q);
        let sx = 0;
        let sy = 0;
        let n = 0;
        for (let j = 0; j < q.length && n < MAX_NEIGHBOURS; j++) {
          const o = q[j];
          if (o === e) continue;
          const ox = e.x - o.x;
          const oy = e.y - o.y;
          const od2 = ox * ox + oy * oy;
          const min = e.r + o.r;
          if (od2 > min * min || od2 < 1e-6) continue;
          const od = Math.sqrt(od2);
          const w = (min - od) / min;
          sx += (ox / od) * w;
          sy += (oy / od) * w;
          n++;
        }
        if (n > 0) {
          ax += sx * 2.6;
          ay += sy * 2.6;
        }
      }

      const al = Math.hypot(ax, ay) || 1;
      let spd = e.spd;
      if (e.stun > 0) {
        e.stun -= step;
        spd *= 0.25;
      }

      // Knockback velocity decays; steering blends in on top of it.
      e.vx += ((ax / al) * spd - e.vx) * Math.min(1, step * 6);
      e.vy += ((ay / al) * spd - e.vy) * Math.min(1, step * 6);
      e.x += e.vx * step;
      e.y += e.vy * step;
      e.ang = Math.atan2(e.vy, e.vx);

      resolveCircle(city, e, e.r, this._hit);
    }
  }

  /** Enemies whose cells overlap the circle. */
  query(x, y, r, out) {
    return this.hash.query(x, y, r, out);
  }

  /** Shove nearby enemies away from a point - used when the car ploughs in. */
  knockback(x, y, radius, power) {
    const q = this.hash.query(x, y, radius, this._q);
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      const dx = e.x - x;
      const dy = e.y - y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > radius) continue;
      const f = (1 - d / radius) * power;
      e.vx += (dx / d) * f;
      e.vy += (dy / d) * f;
      e.stun = Math.max(e.stun, 0.25);
    }
  }
}
