// Keyboard handling. Held keys drive the car; edge-triggered presses are
// queued so a tap is never missed between frames.

const THROTTLE = ['KeyW', 'ArrowUp'];
const BRAKE = ['KeyS', 'ArrowDown'];
const LEFT = ['KeyA', 'ArrowLeft'];
const RIGHT = ['KeyD', 'ArrowRight'];
const SWALLOW = new Set([
  ...THROTTLE, ...BRAKE, ...LEFT, ...RIGHT,
  'Space', 'ShiftLeft', 'ShiftRight', 'KeyP', 'KeyM', 'Enter', 'KeyR',
]);

export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.presses = new Set();

    target.addEventListener('keydown', (e) => {
      if (SWALLOW.has(e.code)) e.preventDefault();
      if (e.repeat) return;           // no auto-repeat on edge events
      this.down.add(e.code);
      this.presses.add(e.code);
    });
    target.addEventListener('keyup', (e) => {
      if (SWALLOW.has(e.code)) e.preventDefault();
      this.down.delete(e.code);
    });
    target.addEventListener('blur', () => this.down.clear());
  }

  held(codes) {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  /** True once per physical key press. */
  pressed(...codes) {
    for (const c of codes) {
      if (this.presses.has(c)) {
        this.presses.delete(c);
        return true;
      }
    }
    return false;
  }

  anyPressed() {
    return this.presses.size > 0;
  }

  endFrame() {
    this.presses.clear();
  }

  read() {
    let throttle = 0;
    let steer = 0;
    const gas = this.held(THROTTLE);
    const brake = this.held(BRAKE);
    if (gas) throttle += 1;
    if (brake) throttle -= 1;
    if (this.held(LEFT)) steer -= 1;
    if (this.held(RIGHT)) steer += 1;
    // Both at once holds the car on the brakes and lights up the tyres.
    return { throttle, steer, burnout: gas && brake };
  }
}
