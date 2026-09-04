// Boot and the main loop. Simulation runs on a fixed 60Hz step so physics is
// identical regardless of display refresh rate; rendering runs once per frame.

import { Game } from './game.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { GameAudio } from './audio.js';
import { makeSprites } from './sprites.js';
import { GEAR_LOW, GEAR_HIGH } from './car.js';
import { ZOMBIE } from './enemies.js';

const STEP = 1 / 60;
const MAX_CATCHUP = 5; // never simulate more than this many steps in one frame

const canvas = document.getElementById('game');
const sprites = makeSprites();
const game = new Game((Math.random() * 0xffffffff) >>> 0);
const renderer = new Renderer(canvas, sprites);
const input = new Input();
const audio = new GameAudio();

const BEST_KEY = 'slickstreets.best';

// Personal best is a per-browser convenience; never let storage break the game.
try {
  const saved = Number(window.localStorage.getItem(BEST_KEY));
  if (Number.isFinite(saved)) game.bestScore = saved;
} catch { /* private mode, or storage disabled */ }

function saveBest() {
  try { window.localStorage.setItem(BEST_KEY, String(game.bestScore)); } catch { /* ignore */ }
}

let paused = false;
let accumulator = 0;
let last = performance.now();

window.addEventListener('resize', () => renderer.resize());
canvas.addEventListener('pointerdown', () => {
  audio.resume();
  if (game.state !== 'playing') startRun();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) paused = true;
});

function startRun() {
  const freshCity = game.state === 'dead';
  game.start();
  // A new run means a new city, so the old bloodstains have to go with it.
  if (freshCity) renderer.reset();
  paused = false;
}

function handleKeys() {
  if (input.pressed('Enter', 'KeyR')) {
    audio.resume();
    if (game.state === 'playing' && input.down.has('KeyR')) {
      // R during a run restarts immediately.
      game.state = 'dead';
    }
    startRun();
  }
  if (input.pressed('KeyP', 'Escape')) {
    if (game.state === 'playing') paused = !paused;
  }
  if (input.pressed('KeyM')) audio.toggleMute();

  if (input.pressed('Space', 'ShiftLeft', 'ShiftRight')) {
    audio.resume();
    game.toggleGear();
  }
}

function drainEvents() {
  for (const ev of game.events) {
    switch (ev.type) {
      case 'kill':
        if (ev.kind === ZOMBIE) audio.splat(ev.speed);
        else audio.bone();
        break;
      case 'crash': audio.crash(ev.force); break;
      case 'shift': audio.shift(); break;
      case 'death':
        audio.death();
        if (game.totalScore > game.bestScore) {
          game.bestScore = game.totalScore;
          saveBest();
        }
        break;
      default: break;
    }
  }
}

function frame(now) {
  requestAnimationFrame(frame);

  let dt = (now - last) / 1000;
  last = now;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  dt = Math.min(dt, 0.25);

  handleKeys();

  if (!paused) {
    audio.beginFrame();
    accumulator += dt;
    let steps = 0;
    while (accumulator >= STEP && steps < MAX_CATCHUP) {
      game.update(STEP, input.read());
      drainEvents();
      accumulator -= STEP;
      steps++;
    }
    if (steps === MAX_CATCHUP) accumulator = 0; // gave up catching up; drop time

    if (game.state === 'playing') {
      audio.engine(game.car.rpm, game.car.gear === GEAR_LOW, game.crowd);
    } else {
      audio.idle();
    }
  } else {
    audio.idle();
  }

  input.endFrame();
  renderer.render(game, paused ? 0 : dt);
  if (paused) renderer.drawPaused();
}

requestAnimationFrame(frame);

// Handy for tinkering from the console.
window.slick = { game, renderer, audio, input, GEAR_LOW, GEAR_HIGH };
