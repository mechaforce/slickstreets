// Simulation owner. Holds the world and steps it; produces `events` that the
// presentation layer turns into sound and screen shake. No DOM in here.

import { generateCity, resolveCircle, isBlocked } from './city.js';
import {
  createCar, updateCar, applyImpact, overlapsCar, bodyCircle,
  BODY_RADIUS, GEAR_LOW, GEAR_HIGH, GEARS, toggleGear, CAR_LENGTH, PX_PER_METRE,
} from './car.js';
import { Swarm, KINDS, ZOMBIE, SKELETON } from './enemies.js';
import { GoreField, MEAT, BONE } from './gore.js';
import { clamp, rr, mulberry32, TAU } from './util.js';

export const MAX_HEALTH = 100;
const CROWD_RADIUS = 82;
const CROWD_NORM = 15;      // enemies-worth of pressure that counts as "mobbed"
const GRAB_SOFT_CAP = 22;   // asymptotic ceiling on damage per second
const REGEN_DELAY = 4.0;
const REGEN_RATE = 3.0;
const COMBO_WINDOW = 1.4;
const RAMP_SECONDS = 260;   // time to reach maximum horde density

const MAX_PARTICLES = 900;

export class Game {
  constructor(seed = Date.now()) {
    this.seed = seed >>> 0;
    this.particles = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles[i] = { live: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, kind: 0, tone: 0 };
    }
    this.pHead = 0;
    this.events = [];
    this._q = [];
    this._tmp = { x: 0, y: 0 };
    this._hit = { nx: 0, ny: 0, depth: 0 };
    this.bestScore = 0; // set by the host from local storage; survives resets
    this.reset(this.seed);
  }

  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed ^ 0x9e3779b9);
    this.city = generateCity(this.seed, 40, 40);
    this.swarm = new Swarm(this.city, this.seed);
    this.gore = new GoreField(this.seed);

    // Start on an intersection near the middle of the map.
    const c = this.city.cell;
    const gx = Math.floor(this.city.cols / 2) * c;
    const gy = Math.floor(this.city.rows / 2) * c;
    this.car = createCar(gx, gy, -Math.PI / 2);
    this.car.gear = GEAR_HIGH;

    this.state = 'title';
    this.time = 0;
    this.health = MAX_HEALTH;
    this.kills = 0;
    this.zombieKills = 0;
    this.skeletonKills = 0;
    this.distance = 0;
    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.bestCombo = 0;
    this.crowd = 0;
    this.goreDrag = 0;
    this.grabbers = 0;
    this.hurtTimer = 0;
    this.shake = 0;
    this.deathCause = '';
    for (const p of this.particles) p.live = false;
    this.events.length = 0;
    this._seedAttractHorde();
  }

  /**
   * Fill the streets around the parked car for the title screen. Ordinary
   * spawning happens out beyond the edge of the view, which would leave the
   * menu looking like an empty city for the first few seconds.
   */
  _seedAttractHorde() {
    const { car, rng } = this;
    for (let i = 0; i < 320; i++) {
      const a = rng() * TAU;
      const d = 220 + Math.sqrt(rng()) * 900;
      const x = car.x + Math.cos(a) * d;
      const y = car.y + Math.sin(a) * d;
      if (isBlocked(this.city, x, y, 10)) continue;
      this.swarm.spawn(x, y, rng() < 0.2 ? SKELETON : ZOMBIE);
    }
  }

  start() {
    if (this.state === 'playing') return;
    if (this.state === 'dead') this.reset((Math.random() * 0xffffffff) >>> 0);
    // The attract-mode horde has been converging on a parked car; clear it so
    // every run starts with room to get moving rather than already buried.
    this.swarm.reset();
    this.gore.reset();
    this.state = 'playing';
    this.events.push({ type: 'start' });
  }

  get difficulty() {
    return clamp(this.time / RAMP_SECONDS, 0, 1);
  }

  emitParticle(x, y, vx, vy, life, size, kind, tone) {
    const p = this.particles[this.pHead];
    this.pHead = (this.pHead + 1) % MAX_PARTICLES;
    p.live = true;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.max = life; p.size = size; p.kind = kind; p.tone = tone;
  }

  shiftTo(gear) {
    if (this.state !== 'playing' || this.car.gear === gear) return;
    this.car.gear = gear;
    this.events.push({ type: 'shift', gear });
  }

  toggleGear() {
    if (this.state !== 'playing') return;
    this.events.push({ type: 'shift', gear: toggleGear(this.car) });
  }

  update(dt, input) {
    this.events.length = 0;
    if (this.state !== 'playing') {
      // Keep the horde milling around behind the menus so it never looks static.
      this.swarm.update(dt, this.car, 0.08);
      this.gore.update(dt);
      this.shake *= Math.exp(-4 * dt);
      return;
    }

    this.time += dt;
    const car = this.car;
    const px = car.x;
    const py = car.y;

    this.swarm.update(dt, car, this.difficulty);

    // ---- run them over ------------------------------------------------
    const speed = Math.abs(car.speed);
    const q = this.swarm.query(car.x, car.y, CROWD_RADIUS, this._q);
    let crowd = 0;
    let grabDamage = 0;
    let grabbers = 0;
    let killsThisFrame = 0;
    let massKilled = 0;

    const cos = Math.cos(car.ang);
    const sin = Math.sin(car.ang);

    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      if (!e.alive) continue;
      const dx = e.x - car.x;
      const dy = e.y - car.y;
      const d = Math.hypot(dx, dy);
      const k = KINDS[e.kind];

      if (d < CROWD_RADIUS) {
        crowd += (1 - d / CROWD_RADIUS) * k.drag;
      }

      if (!overlapsCar(car, e.x, e.y, e.r)) continue;

      if (speed >= k.killSpeed) {
        // Splat. Throw the gore forward along the car's heading.
        const dirx = car.vx / (speed || 1);
        const diry = car.vy / (speed || 1);
        this.gore.burst(e.x, e.y, dirx, diry, speed, e.kind === ZOMBIE ? MEAT : BONE, k.gore);
        for (let s = 0; s < 4; s++) {
          this.emitParticle(
            e.x, e.y,
            dirx * rr(this.rng, 40, 320) + rr(this.rng, -90, 90),
            diry * rr(this.rng, 40, 320) + rr(this.rng, -90, 90),
            rr(this.rng, 0.25, 0.6), rr(this.rng, 1.5, 4),
            e.kind === ZOMBIE ? 0 : 1, this.rng(),
          );
        }
        this.swarm.kill(e);
        killsThisFrame++;
        massKilled += k.mass;
        this.kills++;
        if (e.kind === ZOMBIE) this.zombieKills++; else this.skeletonKills++;
        this.combo++;
        this.comboTimer = COMBO_WINDOW;
        if (this.combo > this.bestCombo) this.bestCombo = this.combo;
        this.score += Math.round(10 * (1 + Math.min(this.combo, 40) * 0.05));
        this.shake = Math.min(this.shake + 0.5 + speed * 0.004, 9);
        this.events.push({ type: 'kill', x: e.x, y: e.y, kind: e.kind, speed });
      } else {
        // Too slow to kill it - now it is clawing at the doors.
        const bite = clamp(1 - speed / k.killSpeed, 0, 1);
        grabDamage += k.damage * bite;
        grabbers++;
      }
    }

    if (killsThisFrame > 0) {
      // Bodies cost you momentum: ploughing a wall of them bleeds speed.
      const drop = clamp(1 - 0.006 * massKilled, 0.7, 1);
      car.vx *= drop;
      car.vy *= drop;
      car.speed *= drop;
      this.swarm.knockback(car.x, car.y, 70, 90 + speed * 0.3);
    }

    this.crowd = clamp(crowd / CROWD_NORM, 0, 1.25);
    this.grabbers = grabbers;

    // ---- drive ---------------------------------------------------------
    updateCar(car, input, dt, { crowd: this.crowd, gore: this.goreDrag });

    // ---- walls ----------------------------------------------------------
    let hitDepth = 0;
    let hnx = 0;
    let hny = 0;
    for (let i = 0; i < 2; i++) {
      const t = bodyCircle(car, i, this._tmp);
      const bx = t.x;
      const by = t.y;
      resolveCircle(this.city, t, BODY_RADIUS, this._hit);
      car.x += t.x - bx;
      car.y += t.y - by;
      if (this._hit.depth > 0) {
        hnx += this._hit.nx;
        hny += this._hit.ny;
        if (this._hit.depth > hitDepth) hitDepth = this._hit.depth;
        // Glancing blows slew the car around rather than stopping it dead.
        const armx = i === 0 ? cos : -cos;
        const army = i === 0 ? sin : -sin;
        car.ang += (armx * this._hit.ny - army * this._hit.nx) * 0.02;
      }
    }
    if (hitDepth > 0.05) {
      const lost = applyImpact(car, hnx, hny);
      // Hitting a building mostly punishes you by stopping you dead in the
      // middle of the horde - the dent itself is the smaller part of it.
      if (lost > 120) {
        this.health -= clamp((lost - 120) * 0.035, 0, 18);
        this.hurtTimer = 0;
        this.shake = Math.min(this.shake + lost * 0.02, 14);
        this.events.push({ type: 'crash', force: lost, x: car.x, y: car.y });
        for (let s = 0; s < 8; s++) {
          this.emitParticle(
            car.x + cos * 26, car.y + sin * 26,
            rr(this.rng, -140, 140), rr(this.rng, -140, 140),
            rr(this.rng, 0.2, 0.5), rr(this.rng, 1, 2.5), 2, this.rng(),
          );
        }
      }
    }

    // ---- gore -----------------------------------------------------------
    this.gore.update(dt);
    this.goreDrag = this.gore.plough(car);

    // ---- damage and healing ---------------------------------------------
    if (grabDamage > 0) {
      // Soft cap: a dozen of them is lethal, but not instantly. You get a few
      // seconds to drop into low gear and grind your way out.
      const dps = grabDamage / (1 + grabDamage / GRAB_SOFT_CAP);
      this.health -= dps * dt;
      this.hurtTimer = 0;
      this.shake = Math.min(this.shake + dps * dt * 0.6, 8);
      if (this.health > 0) this.events.push({ type: 'hurt', amount: dps });
    } else {
      this.hurtTimer += dt;
      if (this.hurtTimer > REGEN_DELAY) {
        this.health = Math.min(MAX_HEALTH, this.health + REGEN_RATE * dt);
      }
    }

    // ---- bookkeeping ------------------------------------------------------
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }
    this.distance += Math.hypot(car.x - px, car.y - py);
    this.shake *= Math.exp(-5 * dt);

    this.updateParticles(dt);

    if (this.health <= 0) {
      this.health = 0;
      this.state = 'dead';
      this.deathCause = grabbers > 0 ? 'DRAGGED FROM THE WRECK' : 'WRAPPED AROUND A WALL';
      this.shake = 16;
      this.events.push({ type: 'death' });
    }
  }

  updateParticles(dt) {
    const arr = this.particles;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (!p.live) continue;
      p.life -= dt;
      if (p.life <= 0) { p.live = false; continue; }
      const fr = Math.exp(-4.5 * dt);
      p.vx *= fr;
      p.vy *= fr;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  get totalScore() {
    const metres = this.distance / PX_PER_METRE;
    return Math.round(this.score + metres * 0.75 + this.time * 2);
  }
}
