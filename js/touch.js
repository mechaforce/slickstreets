// Touch controls: a joystick that lives in the lower third of the screen and
// a gear button under the right thumb.
//
// The stick is directional rather than a pair of arrow keys - you push where
// you want the car to go and it steers itself there, which is the only thing
// that works with a thumb. The mapping from stick to controls is a pure
// function so it can be tested without a browser.

import { clamp, angleDiff, TAU } from './util.js';

/** Push more than this far behind the car and you are asking for the brakes. */
const REVERSE_ARC = 2.36; // radians, 135 degrees
const DEADZONE = 0.18;
const STEER_GAIN = 2.4;

/** Hold the gear button this long and it becomes a burnout instead. */
export const HOLD_FOR_BURNOUT = 0.3;
export const STICK_RADIUS = 74;   // logical px from base to full deflection
export const BUTTON_RADIUS = 52;

/**
 * Turn a stick deflection into throttle and steering.
 *   carAng  - the car's current heading
 *   speed   - signed speed along that heading, so we know if it is reversing
 *   sx, sy  - stick offset from its base, already normalised to 0..1
 */
export function stickToInput(carAng, speed, sx, sy) {
  const mag = Math.hypot(sx, sy);
  if (mag < DEADZONE) return { throttle: 0, steer: 0, active: false };

  const m = clamp((mag - DEADZONE) / (1 - DEADZONE), 0, 1);
  const want = Math.atan2(sy, sx);
  const diff = angleDiff(carAng, want);

  if (Math.abs(diff) <= REVERSE_ARC) {
    // Pointing roughly where the nose already is: drive, steering into it.
    return { throttle: m, steer: clamp(diff * STEER_GAIN, -1, 1), active: true };
  }

  // Pointing back the way you came: brake, and once actually rolling backwards
  // steer so the *rear* of the car swings toward the stick.
  const back = angleDiff(carAng + Math.PI, want);
  const reversing = speed < -5;
  return {
    throttle: -m,
    steer: reversing
      ? clamp(-back * STEER_GAIN, -1, 1)
      : clamp(diff * STEER_GAIN, -1, 1),
    active: true,
  };
}

export class TouchControls {
  constructor(target) {
    /** Only shown once we have seen a real touch, or a coarse pointer. */
    this.enabled = false;
    this.scale = 1;
    this.w = 0;
    this.h = 0;

    this.stick = { id: -1, down: false, baseX: 0, baseY: 0, dx: 0, dy: 0 };
    this.gear = { id: -1, x: 0, y: 0, r: BUTTON_RADIUS, down: false, heldFor: 0 };
    this.pause = { id: -1, x: 0, y: 0, r: 20, down: false };
    this.taps = { gear: false, pause: false };

    try {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
        this.enabled = true;
      }
    } catch { /* matchMedia missing: wait for a real touch instead */ }

    const opts = { passive: false };
    target.addEventListener('pointerdown', (e) => this._down(e), opts);
    target.addEventListener('pointermove', (e) => this._move(e), opts);
    target.addEventListener('pointerup', (e) => this._up(e), opts);
    target.addEventListener('pointercancel', (e) => this._up(e), opts);
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Holding the gear button down, rather than tapping it, does a burnout. */
  get burnout() {
    return this.enabled && this.gear.down && this.gear.heldFor > HOLD_FOR_BURNOUT;
  }

  /** Position the controls for the current screen, in logical HUD units. */
  layout(uw, uh, scale) {
    this.w = uw;
    this.h = uh;
    this.scale = scale;
    this.restX = Math.max(150, uw * 0.14);
    this.restY = uh - Math.max(130, uh * 0.19);
    this.gear.x = uw - Math.max(110, uw * 0.09);
    this.gear.y = uh - Math.max(115, uh * 0.17);
    // Top centre: the corners are taken by the stats and the minimap. On a
    // narrow screen centre would sit on the chassis bar, so keep clear of it.
    const statsRight = 24 + 250 + 34;
    this.pause.x = Math.max(uw / 2, statsRight);
    this.pause.y = 32;
    if (!this.stick.down) {
      this.stick.baseX = this.restX;
      this.stick.baseY = this.restY;
    }
  }

  /** Where the lower third - the joystick's home - starts. */
  get zoneTop() {
    return this.h * (2 / 3);
  }

  _point(e) {
    return { x: e.clientX / this.scale, y: e.clientY / this.scale };
  }

  _hit(btn, p) {
    const dx = p.x - btn.x;
    const dy = p.y - btn.y;
    return dx * dx + dy * dy <= btn.r * btn.r;
  }

  _down(e) {
    if (e.pointerType === 'touch') this.enabled = true;
    if (!this.enabled) return;
    const p = this._point(e);

    if (this._hit(this.gear, p)) {
      e.preventDefault();
      this.gear.id = e.pointerId;
      this.gear.down = true;
      this.taps.gear = true;
      return;
    }
    if (this._hit(this.pause, p)) {
      e.preventDefault();
      this.pause.id = e.pointerId;
      this.pause.down = true;
      this.taps.pause = true;
      return;
    }
    // Anywhere in the lower third plants the stick under your thumb.
    if (p.y >= this.zoneTop && !this.stick.down) {
      e.preventDefault();
      this.stick.id = e.pointerId;
      this.stick.down = true;
      this.stick.baseX = p.x;
      this.stick.baseY = p.y;
      this.stick.dx = 0;
      this.stick.dy = 0;
    }
  }

  _move(e) {
    if (!this.enabled || e.pointerId !== this.stick.id || !this.stick.down) return;
    e.preventDefault();
    const p = this._point(e);
    let dx = p.x - this.stick.baseX;
    let dy = p.y - this.stick.baseY;
    const d = Math.hypot(dx, dy);
    if (d > STICK_RADIUS) {
      // Let the base follow a thumb that has run past the edge, so the stick
      // never gets stuck at full lock in a direction you have left behind.
      this.stick.baseX += dx * (1 - STICK_RADIUS / d);
      this.stick.baseY += dy * (1 - STICK_RADIUS / d);
      dx *= STICK_RADIUS / d;
      dy *= STICK_RADIUS / d;
    }
    this.stick.dx = dx;
    this.stick.dy = dy;
  }

  _up(e) {
    if (e.pointerId === this.stick.id) {
      this.stick.down = false;
      this.stick.id = -1;
      this.stick.dx = 0;
      this.stick.dy = 0;
      this.stick.baseX = this.restX;
      this.stick.baseY = this.restY;
    }
    if (e.pointerId === this.gear.id) {
      this.gear.down = false;
      this.gear.id = -1;
    }
    if (e.pointerId === this.pause.id) {
      this.pause.down = false;
      this.pause.id = -1;
    }
  }

  /** Advance button hold timers. */
  tick(dt) {
    if (this.gear.down) this.gear.heldFor += dt;
    else this.gear.heldFor = 0;
  }

  /** Current throttle and steering, given what the car is doing. */
  read(car) {
    const burning = this.burnout;
    if (!this.enabled || (!this.stick.down && !burning)) {
      return { throttle: 0, steer: 0, active: burning, burnout: burning };
    }
    const r = this.stick.down
      ? stickToInput(car.ang, car.speed, this.stick.dx / STICK_RADIUS, this.stick.dy / STICK_RADIUS)
      : { throttle: 0, steer: 0, active: true };
    // While burning out the stick only steers - the throttle is pinned.
    return { throttle: burning ? 0 : r.throttle, steer: r.steer, active: true, burnout: burning };
  }

  /** Button presses since the last call. */
  consumeTaps() {
    const out = { gear: this.taps.gear, pause: this.taps.pause };
    this.taps.gear = false;
    this.taps.pause = false;
    return out;
  }
}
