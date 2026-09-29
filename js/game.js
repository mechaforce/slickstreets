// Simulation owner. Holds the world and steps it; produces `events` that the
// presentation layer turns into sound and screen shake. No DOM in here.

import { generateCity, resolveCircle, isBlocked } from './city.js';
import {
  createCar, updateCar, applyImpact, overlapsCar, bodyCircle,
  BODY_RADIUS, GEAR_LOW, GEAR_HIGH, GEARS, toggleGear, CAR_LENGTH, CAR_WIDTH,
  PX_PER_METRE,
} from './car.js';
import { Swarm, KINDS, ZOMBIE, SKELETON } from './enemies.js';
import { GoreField, MEAT, BONE, CHAR } from './gore.js';
import { PickupField, PICKUP_KINDS, WIRE, WHEELS, FLAME } from './pickups.js';
import { BloodField } from './fluid.js';
import { clamp, rr, mulberry32, TAU } from './util.js';

export const MAX_HEALTH = 100;
const CROWD_RADIUS = 82;
const CROWD_NORM = 15;      // enemies-worth of pressure that counts as "mobbed"
const GRAB_SOFT_CAP = 22;   // asymptotic ceiling on damage per second
const REGEN_DELAY = 4.0;
const REGEN_RATE = 3.0;
const COMBO_WINDOW = 1.4;
const RAMP_SECONDS = 260;   // time to reach maximum horde density

const MAX_PARTICLES = 1400;

/** Chance per second that any one enemy touching the wire is shredded by it. */
const WIRE_SHRED_RATE = 0.9;
/** Anything busy tearing itself open on the wire is not clawing at you. */
const WIRE_DAMAGE_SCALE = 0.5;
/** How much wider the big wheels make the crushing footprint. */
const WHEEL_WIDTH_SCALE = 1.75;
/** Flamethrower: seconds between bursts, and how long each burst sprays. */
const FLAME_GAP = [3, 5];
const FLAME_SPRAY = 0.6;
const FLAME_RANGE = 205;
const FLAME_HALF_ANGLE = 0.44;

/** How much wet blood each kind of kill pours onto the road. */
const BLOOD_PER_KILL = [0.3, 0.1, 0];   // meat, bone, charred
/** Wet blood depth that counts as a fully slick road. */
const SLIP_SCALE = 1.25;
/** Distance between tyre marks laid down while the tyres are bloody. */
const TRACK_SPACING = 9;
/**
 * The renderer bakes these and clears them. Cap them so a headless run - or a
 * frame where the simulation steps several times before one draw - cannot let
 * them grow without bound.
 */
const MAX_PENDING_MARKS = 512;

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
    this.pickups = new PickupField(this.city, this.seed);
    this.blood = new BloodField();

    // Start on an intersection near the middle of the map.
    const c = this.city.cell;
    const gx = Math.floor(this.city.cols / 2) * c;
    const gy = Math.floor(this.city.rows / 2) * c;
    this.car = createCar(gx, gy, -Math.PI / 2);
    this.car.gear = GEAR_HIGH;
    this.blood.anchor(gx, gy);

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
    // Seconds remaining on each vehicle upgrade, indexed by pickup kind.
    this.power = [0, 0, 0];
    this.flameCooldown = 0;
    this.flameSpray = 0;
    this.lastPickup = -1;
    this.lastPickupAge = 99;
    this.shredKills = 0;
    this.burnKills = 0;
    this._collected = [];
    this.slip = 0;
    this.trackDist = 0;
    this.fluidTick = 0;
    /** Tyre marks waiting to be baked into the permanent stains. */
    this.marks = [];
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
    this.blood.reset();
    this.marks.length = 0;
    this.state = 'playing';
    this.events.push({ type: 'start' });
  }

  /** True while the given pickup kind is active. */
  has(kind) {
    return this.power[kind] > 0;
  }

  /** How wide a path the car currently crushes, in body widths. */
  get crushWidth() {
    return this.has(WHEELS) ? WHEEL_WIDTH_SCALE : 1;
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

  /** Kill one enemy, spray the matching gore, and bank the score for it. */
  killEnemy(e, dirx, diry, power, goreKind, amount) {
    const k = KINDS[e.kind];
    this.gore.burst(e.x, e.y, dirx, diry, power, goreKind, amount);
    const wet = BLOOD_PER_KILL[goreKind];
    if (wet > 0) {
      // Thrown along the direction of the hit, so it sprays rather than pools.
      this.blood.add(e.x, e.y, wet, dirx * power * 0.45, diry * power * 0.45, 24);
    }
    this.swarm.kill(e);
    this.kills++;
    if (e.kind === ZOMBIE) this.zombieKills++; else this.skeletonKills++;
    this.combo++;
    this.comboTimer = COMBO_WINDOW;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.score += Math.round(10 * (1 + Math.min(this.combo, 40) * 0.05));
    return k;
  }

  /**
   * Everything the tyres do to the wet blood: drag it about, pick it up, and
   * lay it back down as tracks. This is what carves a legible path through a
   * pool and what a burnout throws everywhere.
   */
  tyres(dt) {
    const car = this.car;
    const blood = this.blood;
    const cos = Math.cos(car.ang);
    const sin = Math.sin(car.ang);
    const speed = Math.hypot(car.vx, car.vy);
    const spin = car.wheelspin;
    const wet = this.slip;
    const halfW = CAR_WIDTH * 0.5;

    // Front and rear, left and right.
    const wheels = [
      [CAR_LENGTH * 0.30, -halfW], [CAR_LENGTH * 0.30, halfW],
      [-CAR_LENGTH * 0.30, -halfW], [-CAR_LENGTH * 0.30, halfW],
    ];

    let picked = 0;
    for (let i = 0; i < wheels.length; i++) {
      const [lx, ly] = wheels[i];
      const wx = car.x + cos * lx - sin * ly;
      const wy = car.y + sin * lx + cos * ly;
      const rear = i >= 2;

      if (wet > 0.01) {
        // Drag whatever the tyre is standing in along with the car.
        if (speed > 18) blood.addVelocity(wx, wy, car.vx * 0.5, car.vy * 0.5, 14);
        picked += blood.take(wx, wy, 0.16 + spin * 0.3, 13);
      }

      // A spinning rear wheel throws blood backwards in a rooster tail.
      if (rear && spin > 0.2) {
        const throwSpeed = 120 + spin * 520;
        const jitter = rr(this.rng, -0.5, 0.5);
        const a = car.ang + Math.PI + jitter;
        blood.addVelocity(wx, wy, Math.cos(a) * throwSpeed, Math.sin(a) * throwSpeed, 17);

        if (wet > 0.04) {
          for (let s = 0; s < 2; s++) {
            const pa = car.ang + Math.PI + rr(this.rng, -0.7, 0.7);
            const sp = rr(this.rng, 90, 380) * spin;
            this.emitParticle(wx, wy, Math.cos(pa) * sp + car.vx, Math.sin(pa) * sp + car.vy,
              rr(this.rng, 0.3, 0.75), rr(this.rng, 2, 5), 0, this.rng());
          }
        }
        // Tyre smoke, blood or no blood.
        if (this.rng() < 0.7) {
          this.emitParticle(wx, wy, rr(this.rng, -50, 50) + car.vx * 0.3,
            rr(this.rng, -50, 50) + car.vy * 0.3,
            rr(this.rng, 0.5, 1.2), rr(this.rng, 5, 11), 4, this.rng());
        }
      }
    }

    car.tyreBlood = clamp(car.tyreBlood + picked * 2.6 - dt * 0.28, 0, 1);

    // Lay tracks at a fixed spacing along the ground, not per frame, so they
    // do not bunch up when slow or leave gaps when quick.
    this.trackDist += speed * dt;
    const laying = car.tyreBlood > 0.02 || spin > 0.25;
    if (laying && (this.trackDist >= TRACK_SPACING || spin > 0.25)) {
      this.trackDist = 0;
      const strength = clamp(car.tyreBlood * 0.9 + spin * 0.5, 0.08, 1);
      for (let i = 2; i < 4; i++) {
        const [lx, ly] = wheels[i];
        this.marks.push({
          x: car.x + cos * lx - sin * ly,
          y: car.y + sin * lx + cos * ly,
          ang: car.ang,
          w: 15 + spin * 12,
          h: 8 + spin * 5,
          a: strength * (0.3 + spin * 0.45),
          blood: clamp(car.tyreBlood * 1.3 + wet, 0, 1),
        });
      }
      car.tyreBlood = Math.max(0, car.tyreBlood - 0.035);
      if (this.marks.length > MAX_PENDING_MARKS) {
        this.marks.splice(0, this.marks.length - MAX_PENDING_MARKS);
      }
    }
  }

  /** The flamethrower's cone, swept every frame while it is spraying. */
  burn(dt) {
    const car = this.car;
    const cos = Math.cos(car.ang);
    const sin = Math.sin(car.ang);
    const mx = car.x + cos * CAR_LENGTH * 0.5;
    const my = car.y + sin * CAR_LENGTH * 0.5;

    const q = this.swarm.query(mx + cos * FLAME_RANGE * 0.5, my + sin * FLAME_RANGE * 0.5,
      FLAME_RANGE, this._q);
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      if (!e.alive) continue;
      const dx = e.x - mx;
      const dy = e.y - my;
      const d = Math.hypot(dx, dy);
      if (d > FLAME_RANGE) continue;
      // Inside the cone? Everything close to the muzzle counts.
      if (d > 26 && (dx * cos + dy * sin) / d < Math.cos(FLAME_HALF_ANGLE)) continue;
      this.killEnemy(e, dx / (d || 1), dy / (d || 1), 120, CHAR, 5);
      this.burnKills++;
      this.events.push({ type: 'kill', x: e.x, y: e.y, kind: e.kind, speed: 0, burned: true });
      for (let s2 = 0; s2 < 3; s2++) {
        this.emitParticle(e.x, e.y, rr(this.rng, -60, 60), rr(this.rng, -60, 60),
          rr(this.rng, 0.3, 0.7), rr(this.rng, 2, 5), 3, this.rng());
      }
    }

    // The spray itself.
    const jets = 7;
    for (let i = 0; i < jets; i++) {
      const a = car.ang + rr(this.rng, -FLAME_HALF_ANGLE, FLAME_HALF_ANGLE);
      const sp = rr(this.rng, 260, 620);
      this.emitParticle(
        mx + rr(this.rng, -4, 4), my + rr(this.rng, -4, 4),
        Math.cos(a) * sp + car.vx * 0.5, Math.sin(a) * sp + car.vy * 0.5,
        rr(this.rng, 0.22, 0.5), rr(this.rng, 3, 7), 3, this.rng(),
      );
      if (this.rng() < 0.4) {
        this.emitParticle(
          mx + Math.cos(a) * 60, my + Math.sin(a) * 60,
          Math.cos(a) * sp * 0.3 + rr(this.rng, -40, 40),
          Math.sin(a) * sp * 0.3 + rr(this.rng, -40, 40),
          rr(this.rng, 0.5, 1.1), rr(this.rng, 4, 9), 4, this.rng(),
        );
      }
    }
  }

  update(dt, input) {
    this.events.length = 0;
    if (this.state !== 'playing') {
      // Keep the horde milling around behind the menus so it never looks static.
      this.swarm.update(dt, this.car, 0.08);
      this.gore.update(dt);
      this.fluidTick ^= 1;
      if (this.fluidTick === 0) this.blood.step(dt * 2);
      this.shake *= Math.exp(-4 * dt);
      return;
    }

    this.time += dt;
    const car = this.car;
    const px = car.x;
    const py = car.y;

    // Upgrades run down, and driving over a crate tops one back up.
    for (let i = 0; i < this.power.length; i++) {
      if (this.power[i] > 0) this.power[i] = Math.max(0, this.power[i] - dt);
    }
    this.lastPickupAge += dt;
    this.pickups.update(dt, car, this._collected);
    for (const kind of this._collected) {
      this.power[kind] = PICKUP_KINDS[kind].duration;
      this.lastPickup = kind;
      this.lastPickupAge = 0;
      // Fire the first burst almost at once, so picking it up feels like something.
      if (kind === FLAME) this.flameCooldown = Math.min(this.flameCooldown, 0.5);
      this.events.push({ type: 'pickup', kind });
    }

    // ---- wet blood -------------------------------------------------------
    this.blood.anchor(car.x, car.y);
    this.slip = clamp(this.blood.sample(car.x, car.y) * SLIP_SCALE, 0, 1);

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

    const crushWidth = this.crushWidth;
    const wired = this.has(WIRE);

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

      // The wide footprint decides what gets crushed; only what is actually
      // against the bodywork can grab you or catch on the wire.
      if (!overlapsCar(car, e.x, e.y, e.r, crushWidth)) continue;

      if (speed >= k.killSpeed) {
        // Splat. Throw the gore forward along the car's heading.
        const dirx = car.vx / (speed || 1);
        const diry = car.vy / (speed || 1);
        this.killEnemy(e, dirx, diry, speed, e.kind === ZOMBIE ? MEAT : BONE, k.gore);
        for (let s = 0; s < 8; s++) {
          this.emitParticle(
            e.x, e.y,
            dirx * rr(this.rng, 40, 380) + rr(this.rng, -120, 120),
            diry * rr(this.rng, 40, 380) + rr(this.rng, -120, 120),
            rr(this.rng, 0.25, 0.7), rr(this.rng, 1.5, 5),
            e.kind === ZOMBIE ? 0 : 1, this.rng(),
          );
        }
        killsThisFrame++;
        massKilled += k.mass;
        this.shake = Math.min(this.shake + 0.5 + speed * 0.004, 9);
        this.events.push({ type: 'kill', x: e.x, y: e.y, kind: e.kind, speed });
      } else if (overlapsCar(car, e.x, e.y, e.r)) {
        if (wired && this.rng() < WIRE_SHRED_RATE * dt) {
          // Caught on the barbed wire and torn apart against the bodywork.
          const inv = 1 / (d || 1);
          this.killEnemy(e, dx * inv, dy * inv, 90, MEAT, 6);
          this.shredKills++;
          this.events.push({ type: 'kill', x: e.x, y: e.y, kind: e.kind, speed, shredded: true });
        } else {
          // Too slow to kill it - now it is clawing at the doors.
          const bite = clamp(1 - speed / k.killSpeed, 0, 1);
          grabDamage += k.damage * bite * (wired ? WIRE_DAMAGE_SCALE : 1);
          grabbers++;
        }
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
    updateCar(car, input, dt, { crowd: this.crowd, gore: this.goreDrag, slip: this.slip });

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

    // ---- flamethrower ----------------------------------------------------
    if (this.has(FLAME)) {
      this.flameCooldown -= dt;
      if (this.flameCooldown <= 0) {
        this.flameCooldown = rr(this.rng, FLAME_GAP[0], FLAME_GAP[1]);
        this.flameSpray = FLAME_SPRAY;
        this.events.push({ type: 'flame' });
      }
    }
    if (this.flameSpray > 0) {
      this.flameSpray -= dt;
      this.burn(dt);
    }

    // ---- gore -----------------------------------------------------------
    this.gore.update(dt);
    this.goreDrag = this.gore.plough(car, crushWidth);
    this.tyres(dt);
    // The fluid runs at half rate; it is smooth enough and costs half as much.
    this.fluidTick ^= 1;
    if (this.fluidTick === 0) this.blood.step(dt * 2);

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
