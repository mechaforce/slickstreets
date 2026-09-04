// Pure arcade car physics. No canvas, no DOM - the headless tests drive this
// directly to check that the gearbox behaves the way the design wants.

import { clamp, sign, TAU } from './util.js';

export const GEAR_LOW = 0;
export const GEAR_HIGH = 1;

export const CAR_LENGTH = 62;
export const CAR_WIDTH = 30;

/**
 * World units are pixels. These fix the one scale the HUD reports in, so the
 * speedometer and the distance readout agree with each other:
 * 62px of car ~ 3.3m, and a 660px/s top speed ~ 125km/h.
 */
export const KMH_PER_PX = 0.19;
export const PX_PER_METRE = 18.95;

/**
 * LOW  - little top speed but full torque from a standstill, so it can drag
 *        the car out of a swarm that has bogged it down.
 * HIGH - long legs and a high top speed, but almost no torque down low: get
 *        stopped by a crowd in high gear and you are not getting going again.
 */
export const GEARS = [
  { name: 'LOW',  maxSpeed: 235, force: 900, turn: 3.5, grip: 13, torqueFloor: 1.0,  torqueKnee: 1 },
  { name: 'HIGH', maxSpeed: 660, force: 620, turn: 2.4, grip: 8.5, torqueFloor: 0.22, torqueKnee: 220 },
];

export const REVERSE_SPEED = 130;
/** Acceleration applied per unit of crowd pressure (pressure 1 = fully mobbed). */
export const CROWD_DRAG = 640;

export function createCar(x, y, ang = 0) {
  return {
    x, y, ang,
    vx: 0, vy: 0,
    gear: GEAR_HIGH,
    speed: 0,        // signed, along the heading
    rpm: 0,          // 0..1, for the engine note and the tacho
    steer: 0,        // smoothed steering input
    lastImpact: 0,   // speed lost to the most recent wall hit
  };
}

export function shiftGear(car, gear) {
  if (car.gear === gear) return false;
  car.gear = gear;
  return true;
}

export function toggleGear(car) {
  car.gear = car.gear === GEAR_LOW ? GEAR_HIGH : GEAR_LOW;
  return car.gear;
}

/** Fraction of peak engine force available at the current speed. */
export function torqueAt(gear, speed) {
  const g = GEARS[gear];
  return clamp(g.torqueFloor + (1 - g.torqueFloor) * (speed / g.torqueKnee), 0, 1);
}

/**
 * Advance the car one step.
 *   input: { throttle: -1..1, steer: -1..1 }
 *   env:   { crowd: 0..1+ swarm pressure, gore: 0..1 gore drag }
 */
export function updateCar(car, input, dt, env) {
  const g = GEARS[car.gear];
  const crowd = env && env.crowd ? env.crowd : 0;
  const gore = env && env.gore ? env.gore : 0;

  const cos = Math.cos(car.ang);
  const sin = Math.sin(car.ang);

  // Split velocity into forward / lateral so we can apply grip to the slide.
  let fwd = car.vx * cos + car.vy * sin;
  let lat = -car.vx * sin + car.vy * cos;

  const throttle = clamp(input.throttle || 0, -1, 1);

  let accel = 0;
  if (throttle > 0) {
    const torque = torqueAt(car.gear, Math.max(0, fwd));
    const headroom = 1 - Math.pow(clamp(fwd / g.maxSpeed, 0, 1), 1.6);
    accel = g.force * torque * headroom * throttle;
  } else if (throttle < 0) {
    // Brake hard while rolling forward, then creep backwards.
    accel = fwd > 12 ? -1500 * -throttle : -520 * -throttle;
    if (fwd < -REVERSE_SPEED) accel = 0;
  }

  // Rolling resistance plus whatever is currently clogging the wheels.
  const resist = 0.55 * fwd + sign(fwd) * (crowd * CROWD_DRAG + gore * 260);
  fwd += (accel - resist) * dt;

  // Crowd pressure also caps outright top speed, so a thick mob is a wall.
  const cap = g.maxSpeed * (1 - 0.55 * clamp(crowd, 0, 1));
  if (fwd > cap) fwd += (cap - fwd) * Math.min(1, dt * 4);
  if (fwd < -REVERSE_SPEED) fwd = -REVERSE_SPEED;
  if (Math.abs(fwd) < 1.5 && throttle === 0) fwd = 0;

  // Tyres scrub off sideways velocity; less grip when the crowd is shoving.
  lat -= lat * Math.min(1, g.grip * dt * (1 - 0.35 * clamp(crowd, 0, 1)));

  // Steering authority falls away at very low and very high speed.
  const target = clamp(input.steer || 0, -1, 1);
  car.steer += (target - car.steer) * Math.min(1, dt * 12);
  const gripSpeed = clamp(Math.abs(fwd) / 90, 0, 1);
  const fast = 1 - 0.45 * clamp(Math.abs(fwd) / g.maxSpeed, 0, 1);
  car.ang += car.steer * g.turn * gripSpeed * fast * sign(fwd || 1) * dt;
  if (car.ang > Math.PI) car.ang -= TAU;
  if (car.ang < -Math.PI) car.ang += TAU;

  const c2 = Math.cos(car.ang);
  const s2 = Math.sin(car.ang);
  car.vx = fwd * c2 - lat * s2;
  car.vy = fwd * s2 + lat * c2;
  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.speed = fwd;

  const targetRpm = clamp(Math.abs(fwd) / g.maxSpeed, 0, 1) * 0.8 + (throttle > 0 ? 0.2 : 0.05);
  car.rpm += (targetRpm - car.rpm) * Math.min(1, dt * 6);
  return car;
}

/**
 * Bleed speed when the car body hits something solid.
 * A grazing scrape only cancels the velocity going into the wall, so you can
 * slide along a building; a square-on hit scrubs most of your momentum.
 * Returns the speed lost, which the caller turns into damage and shake.
 */
export function applyImpact(car, nx, ny) {
  const len = Math.hypot(nx, ny);
  if (len < 1e-5) return 0;
  nx /= len;
  ny /= len;
  const into = car.vx * nx + car.vy * ny; // negative when driving into the wall
  if (into >= 0) return 0;
  const lost = -into;

  // Cancel the component going into the wall, with a little bounce back.
  const restitution = 0.18;
  car.vx -= nx * into * (1 + restitution);
  car.vy -= ny * into * (1 + restitution);

  // Scrub tangential speed in proportion to how hard the hit was.
  const scrub = clamp(lost / 320, 0, 1) * 0.55;
  car.vx *= 1 - scrub;
  car.vy *= 1 - scrub;

  car.speed = car.vx * Math.cos(car.ang) + car.vy * Math.sin(car.ang);
  car.lastImpact = lost;
  return lost;
}

/**
 * Circle-vs-oriented-box test used for running things over. `widthScale`
 * widens the crush footprint without widening the car itself, which is what
 * the big wheels do: a broader path through the horde, same body to squeeze
 * down the same streets.
 */
export function overlapsCar(car, x, y, r, widthScale = 1) {
  const dx = x - car.x;
  const dy = y - car.y;
  const cos = Math.cos(car.ang);
  const sin = Math.sin(car.ang);
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  return Math.abs(lx) < CAR_LENGTH * 0.5 + r && Math.abs(ly) < CAR_WIDTH * 0.5 * widthScale + r;
}

/** World-space point of the two collision circles approximating the body. */
export function bodyCircle(car, which, out) {
  const off = which === 0 ? CAR_LENGTH * 0.26 : -CAR_LENGTH * 0.26;
  out.x = car.x + Math.cos(car.ang) * off;
  out.y = car.y + Math.sin(car.ang) * off;
  return out;
}
export const BODY_RADIUS = CAR_WIDTH * 0.55;
