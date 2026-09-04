import test from 'node:test';
import assert from 'node:assert/strict';

import { generateCity, isBlocked, CELL } from '../js/city.js';
import { createCar, updateCar, GEAR_LOW, GEAR_HIGH, GEARS, torqueAt, applyImpact } from '../js/car.js';
import { Game } from '../js/game.js';
import { ZOMBIE, SKELETON, KINDS } from '../js/enemies.js';
import { createBot, botInput } from './bot.mjs';

const STEP = 1 / 60;

function run(game, seconds, input) {
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) {
    game.update(STEP, typeof input === 'function' ? input(i) : input);
  }
}

/** Pack `n` enemies into a ring around the car to simulate being mobbed. */
function mob(game, n, radius = 60) {
  const { car } = game;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const d = 18 + (i % 5) * (radius / 5);
    game.swarm.spawn(car.x + Math.cos(a) * d, car.y + Math.sin(a) * d, ZOMBIE);
  }
}

test('city: streets are drivable and block interiors are solid', () => {
  const city = generateCity(3, 12, 12);
  assert.ok(city.solids.length > 100, 'city should contain obstacles');
  for (let cx = 1; cx < 11; cx++) {
    for (let cy = 1; cy < 11; cy++) {
      assert.equal(isBlocked(city, cx * CELL, cy * CELL, 24), false,
        `intersection ${cx},${cy} must be clear`);
    }
  }
  const sameSeed = generateCity(3, 12, 12);
  assert.equal(sameSeed.solids.length, city.solids.length, 'generation is deterministic');
});

test('car: high gear out-runs low gear on an open road', () => {
  const top = (gear) => {
    const c = createCar(0, 0, 0);
    c.gear = gear;
    for (let i = 0; i < 60 * 20; i++) updateCar(c, { throttle: 1, steer: 0 }, STEP, {});
    return c.speed;
  };
  const low = top(GEAR_LOW);
  const high = top(GEAR_HIGH);
  assert.ok(high > low * 2, `high gear (${high.toFixed(0)}) should far exceed low (${low.toFixed(0)})`);
  assert.ok(low > 200, 'low gear should still be usefully quick');
});

test('car: low gear has torque off the line, high gear does not', () => {
  assert.ok(torqueAt(GEAR_LOW, 0) > torqueAt(GEAR_HIGH, 0) * 3);
  assert.ok(torqueAt(GEAR_HIGH, 400) > 0.95, 'high gear comes alive once moving');
});

test('car: low gear drags you out of a swarm, high gear bogs down', () => {
  const escape = (gear) => {
    const c = createCar(0, 0, 0);
    c.gear = gear;
    for (let i = 0; i < 60 * 5; i++) updateCar(c, { throttle: 1, steer: 0 }, STEP, { crowd: 1 });
    return c.speed;
  };
  const low = escape(GEAR_LOW);
  const high = escape(GEAR_HIGH);
  assert.ok(low > KINDS[ZOMBIE].killSpeed,
    `low gear (${low.toFixed(0)}) must out-run the kill threshold to break free`);
  assert.ok(high < 40, `high gear (${high.toFixed(0)}) should be stuck fast`);
});

test('car: grazing a wall keeps you moving, a head-on hit does not', () => {
  const graze = createCar(0, 0, 0);
  graze.vx = 400;
  graze.vy = 20;
  graze.speed = 400;
  applyImpact(graze, 0, -1); // wall on the right, sliding along it
  assert.ok(graze.vx > 330, `slide should preserve speed, kept ${graze.vx.toFixed(0)}`);

  const headOn = createCar(0, 0, 0);
  headOn.vx = 400;
  headOn.speed = 400;
  const lost = applyImpact(headOn, -1, 0);
  assert.ok(lost > 300, 'a square hit reports a big impact');
  assert.ok(headOn.vx < 100, `square hit should kill speed, kept ${headOn.vx.toFixed(0)}`);
});

test('game: driving fast over the horde kills it and makes gore', () => {
  const g = new Game(11);
  g.start();
  g.car.gear = GEAR_HIGH;
  run(g, 6, { throttle: 1, steer: 0 });
  const before = g.kills;
  assert.ok(Math.abs(g.car.speed) > KINDS[ZOMBIE].killSpeed, 'should be up to speed');

  mob(g, 40, 40);
  run(g, 1, { throttle: 1, steer: 0 });
  assert.ok(g.kills > before, 'ploughing into a mob at speed kills');
  assert.ok(g.gore.live > 0, 'kills leave gore chunks behind');
  assert.ok(g.gore.splats.length > 0, 'kills queue blood decals');
});

test('game: too slow to kill means they kill you', () => {
  const g = new Game(12);
  g.start();
  mob(g, 60, 55);
  const hp = g.health;
  run(g, 2, { throttle: 0, steer: 0 });
  assert.ok(g.health < hp, 'a stationary car in a crowd takes damage');
  assert.ok(g.grabbers > 0, 'enemies should be reported as grabbing');
  assert.ok(g.crowd > 0.3, `crowd pressure should be high, was ${g.crowd.toFixed(2)}`);

  run(g, 20, { throttle: 0, steer: 0 });
  assert.equal(g.state, 'dead', 'standing still in a swarm is fatal');
});

test('game: damage is soft-capped so a swarm is escapable, not instant', () => {
  const g = new Game(13);
  g.start();
  mob(g, 120, 60);
  g.update(STEP, { throttle: 0, steer: 0 });
  const hp = g.health;
  run(g, 1, { throttle: 0, steer: 0 });
  const dps = hp - g.health;
  assert.ok(dps > 4, `being mobbed must hurt, lost ${dps.toFixed(1)}/s`);
  assert.ok(dps < 30, `but not instantly lethal, lost ${dps.toFixed(1)}/s`);
});

test('gore: the car shoves piles aside instead of driving through them', () => {
  const g = new Game(14);
  g.start();
  const { car } = g;
  car.ang = 0;
  // Lay a pile directly in the car's path.
  for (let i = 0; i < 60; i++) {
    g.gore.burst(car.x + 4, car.y + (i % 7) - 3, 1, 0, 0, 0, 1);
  }
  for (const c of g.gore.chunks) { c.vx = 0; c.vy = 0; c.moving = false; }
  g.gore.update(STEP); // settle the pile and build the lookup grid
  const spread = () => {
    let sum = 0;
    let n = 0;
    for (const c of g.gore.chunks) {
      if (!c.live) continue;
      sum += Math.abs(c.y - car.y);
      n++;
    }
    return sum / n;
  };
  const before = spread();
  car.vx = 300;
  car.speed = 300;
  g.gore.plough(car);
  g.gore.update(STEP);
  const after = spread();
  assert.ok(after > before, `chunks should be pushed clear of the car (${before.toFixed(1)} -> ${after.toFixed(1)})`);
});

test('game: reset and restart produce a clean run', () => {
  const g = new Game(15);
  g.start();
  run(g, 3, { throttle: 1, steer: 0.3 });
  g.state = 'dead';
  g.start();
  assert.equal(g.state, 'playing');
  assert.equal(g.kills, 0);
  assert.equal(g.health, 100);
  assert.equal(g.swarm.count, 0);
  assert.equal(g.gore.live, 0);
});

test('game: a bot playing properly survives and racks up kills', () => {
  for (const seed of [9, 42, 777]) {
    const g = new Game(seed);
    g.start();
    const bot = createBot(g, seed);
    let frames = 0;
    for (; frames < 60 * 120; frames++) {
      g.update(STEP, botInput(bot, STEP));
      if (g.state === 'dead') break;
    }
    const secs = frames / 60;
    assert.ok(secs > 12, `seed ${seed}: bot survived only ${secs.toFixed(1)}s`);
    assert.ok(g.kills > 25, `seed ${seed}: only ${g.kills} kills`);
    assert.ok(g.swarm.count > 200, `seed ${seed}: horde should be large, was ${g.swarm.count}`);
  }
});

test('performance: a dense frame stays well inside a 16ms budget', () => {
  const g = new Game(21);
  g.start();
  const bot = createBot(g, 5);
  run(g, 30, () => botInput(bot, STEP));
  for (let i = 0; i < 1500; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 200 + Math.random() * 900;
    g.swarm.spawn(g.car.x + Math.cos(a) * d, g.car.y + Math.sin(a) * d,
      Math.random() < 0.4 ? SKELETON : ZOMBIE);
  }
  const frames = 120;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) g.update(STEP, botInput(bot, STEP));
  const per = (performance.now() - t0) / frames;
  assert.ok(g.swarm.count > 800, `should still be simulating a horde (${g.swarm.count})`);
  assert.ok(per < 8, `sim step averaged ${per.toFixed(2)}ms with ${g.swarm.count} enemies`);
  console.log(`    sim: ${per.toFixed(2)}ms/frame, ${g.swarm.count} enemies, ${g.gore.live} gore chunks`);
});
