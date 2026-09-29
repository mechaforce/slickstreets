import test from 'node:test';
import assert from 'node:assert/strict';

import { generateCity, isBlocked, CELL } from '../js/city.js';
import { createCar, updateCar, GEAR_LOW, GEAR_HIGH, GEARS, torqueAt, applyImpact } from '../js/car.js';
import { Game } from '../js/game.js';
import { ZOMBIE, SKELETON, KINDS } from '../js/enemies.js';
import { createBot, botInput } from './bot.mjs';
import { PickupField, PICKUP_KINDS, WIRE, WHEELS, FLAME } from '../js/pickups.js';
import { CAR_WIDTH } from '../js/car.js';
import { stickToInput, STICK_RADIUS } from '../js/touch.js';
import { BloodField } from '../js/fluid.js';

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

// ---------------------------------------------------------------------------
// Vehicle upgrades
// ---------------------------------------------------------------------------

test('pickups: crates are scattered over the whole map and restocked', () => {
  const city = generateCity(5, 40, 40);
  const field = new PickupField(city, 5);
  assert.ok(field.count > 150, `expected a good spread, got ${field.count}`);

  // Spread across the map rather than clustered in one district.
  const xs = field.items.map((p) => p.x);
  const ys = field.items.map((p) => p.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) > city.width * 0.8, 'crates span the map west to east');
  assert.ok(Math.max(...ys) - Math.min(...ys) > city.height * 0.8, 'crates span the map north to south');

  // All three kinds are represented, and none is buried in a building.
  const kinds = new Set(field.items.map((p) => p.kind));
  assert.equal(kinds.size, PICKUP_KINDS.length);
  for (const p of field.items) {
    assert.equal(isBlocked(city, p.x, p.y, 8), false, 'a crate must be reachable on the road');
  }
});

test('pickups: driving over a crate arms that upgrade and a new one appears', () => {
  const g = new Game(16);
  g.start();
  const crate = g.pickups.items[0];
  const before = g.pickups.count;
  g.car.x = crate.x;
  g.car.y = crate.y;

  g.update(STEP, { throttle: 0, steer: 0 });
  assert.ok(g.power[crate.kind] > 0, 'the upgrade should now be running');
  assert.equal(g.lastPickup, crate.kind);
  assert.ok(g.events.some((e) => e.type === 'pickup'), 'collection raises an event');
  assert.equal(g.pickups.count, before, 'a replacement crate is placed elsewhere');

  // And it runs out on its own.
  const armed = g.power[crate.kind];
  run(g, 2, { throttle: 0, steer: 0 });
  assert.ok(g.power[crate.kind] < armed, 'the timer counts down');
});

test('barbed wire: shreds what touches the car, and blunts what it does not', () => {
  const measure = (wired) => {
    const g = new Game(17);
    g.start();
    for (let i = 0; i < 50; i++) {
      const a = (i / 50) * Math.PI * 2;
      const d = 16 + (i % 5) * 10;
      g.swarm.spawn(g.car.x + Math.cos(a) * d, g.car.y + Math.sin(a) * d, ZOMBIE);
    }
    if (wired) g.power[WIRE] = 30;
    const hp = g.health;
    run(g, 3, { throttle: 0, steer: 0 });
    return { shredded: g.shredKills, lost: hp - g.health };
  };
  const plain = measure(false);
  const wired = measure(true);

  assert.equal(plain.shredded, 0, 'no wire, no shredding');
  assert.ok(wired.shredded > 10, `wire should be killing them, got ${wired.shredded}`);
  assert.ok(wired.lost < plain.lost * 0.8,
    `wire should cut the damage taken (${wired.lost.toFixed(1)} vs ${plain.lost.toFixed(1)})`);
});

test('big wheels: widen what you crush without widening the car', () => {
  const crushes = (wheels) => {
    const g = new Game(18);
    g.start();
    g.car.ang = 0;
    g.car.vx = 400;
    g.car.speed = 400;
    if (wheels) g.power[WHEELS] = 30;
    // Sit it beyond the bodywork but inside the reach of the big wheels.
    g.swarm.spawn(g.car.x, g.car.y + CAR_WIDTH * 0.5 + 15, ZOMBIE);
    const before = g.kills;
    g.update(STEP, { throttle: 1, steer: 0 });
    return g.kills > before;
  };
  assert.equal(crushes(false), false, 'normally that one is outside the car');
  assert.equal(crushes(true), true, 'the big wheels reach it');

  const g = new Game(18);
  g.start();
  assert.equal(g.crushWidth, 1);
  g.power[WHEELS] = 10;
  assert.ok(g.crushWidth > 1.5, 'the crushing footprint gets much wider');
});

test('flamethrower: burns a cone off the nose, and nothing else', () => {
  const g = new Game(19);
  g.start();
  g.car.ang = 0;
  const front = g.swarm.spawn(g.car.x + 130, g.car.y, ZOMBIE);
  const offCone = g.swarm.spawn(g.car.x + 60, g.car.y + 90, ZOMBIE);
  const behind = g.swarm.spawn(g.car.x - 130, g.car.y, ZOMBIE);
  const tooFar = g.swarm.spawn(g.car.x + 300, g.car.y, ZOMBIE);
  g.swarm.update(STEP, g.car, 0); // the lookup grid the cone queries

  g.burn(STEP);
  assert.equal(front.alive, false, 'straight ahead gets burned');
  assert.equal(behind.alive, true, 'behind the car is safe');
  assert.equal(offCone.alive, true, 'outside the cone is safe');
  assert.equal(tooFar.alive, true, 'beyond the range is safe');
  assert.ok(g.burnKills > 0);
  assert.ok(g.gore.chunks.some((c) => c.live && c.type === 2), 'burning leaves charred remains');
});

test('flamethrower: fires every few seconds while it is armed', () => {
  const g = new Game(20);
  g.start();
  g.power[FLAME] = 999;
  g.flameCooldown = 4;
  let bursts = 0;
  const gaps = [];
  let last = 0;
  for (let i = 0; i < 60 * 30; i++) {
    g.update(STEP, { throttle: 0, steer: 0 });
    if (g.events.some((e) => e.type === 'flame')) {
      bursts++;
      gaps.push(g.time - last);
      last = g.time;
    }
    // Keep it armed and alive: this test is about cadence, nothing else.
    g.power[FLAME] = 999;
    g.health = 100;
  }
  assert.ok(bursts >= 6 && bursts <= 10, `expected roughly one burst every 3-5s, got ${bursts} in 30s`);
  for (const gap of gaps.slice(1)) {
    assert.ok(gap >= 2.9 && gap <= 5.1, `gap between bursts was ${gap.toFixed(2)}s`);
  }
});

test('upgrades: an armed car clears a swarm that would otherwise stop it', () => {
  const survive = (armed) => {
    const g = new Game(22);
    g.start();
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      const d = 18 + (i % 8) * 9;
      g.swarm.spawn(g.car.x + Math.cos(a) * d, g.car.y + Math.sin(a) * d, ZOMBIE);
    }
    if (armed) {
      g.power[WIRE] = 60;
      g.power[FLAME] = 60;
      g.flameCooldown = 0.2;
    }
    let frames = 0;
    for (; frames < 60 * 20; frames++) {
      g.update(STEP, { throttle: 1, steer: 0 });
      if (g.state === 'dead') break;
      if (armed) { g.power[WIRE] = 60; g.power[FLAME] = 60; }
    }
    return { secs: frames / 60, kills: g.kills };
  };
  const bare = survive(false);
  const armed = survive(true);
  assert.ok(armed.kills > bare.kills * 1.5,
    `upgrades should clear far more (${armed.kills} vs ${bare.kills})`);
});

// ---------------------------------------------------------------------------
// Touch controls
// ---------------------------------------------------------------------------

test('joystick: a centred stick asks for nothing', () => {
  const r = stickToInput(0, 0, 0.05, 0.05);
  assert.equal(r.active, false);
  assert.equal(r.throttle, 0);
  assert.equal(r.steer, 0);
});

test('joystick: push where you want to go and the car steers there', () => {
  // Car pointing east (+x). Stick east: straight on, no steering.
  const ahead = stickToInput(0, 200, 1, 0);
  assert.ok(ahead.throttle > 0.9, 'full deflection is full throttle');
  assert.ok(Math.abs(ahead.steer) < 0.05, 'no steering needed');

  // Stick south (+y on screen) is a right turn for an eastbound car.
  const right = stickToInput(0, 200, 0, 1);
  assert.ok(right.steer > 0.9, 'steers right');
  const left = stickToInput(0, 200, 0, -1);
  assert.ok(left.steer < -0.9, 'steers left');

  // Steering is proportional near the middle, not just on/off.
  const slight = stickToInput(0, 200, 1, 0.2);
  assert.ok(slight.steer > 0.05 && slight.steer < right.steer, 'a gentle push is a gentle turn');
});

test('joystick: pulling back brakes, then reverses', () => {
  // Rolling forwards: pull back and it asks for the brakes.
  const braking = stickToInput(0, 260, -1, 0);
  assert.ok(braking.throttle < 0, 'negative throttle is the brake');

  // Actually reversing now: steering mirrors so the tail follows the stick.
  const backLeft = stickToInput(0, -40, -1, -0.4);
  const backRight = stickToInput(0, -40, -1, 0.4);
  assert.ok(Math.sign(backLeft.steer) !== Math.sign(backRight.steer),
    'the two directions must not both steer the same way');
});

test('joystick: partial deflection gives partial throttle', () => {
  const half = stickToInput(0, 0, 0.5, 0);
  const full = stickToInput(0, 0, 1, 0);
  assert.ok(half.throttle > 0 && half.throttle < full.throttle * 0.75,
    `expected a lighter throttle, got ${half.throttle.toFixed(2)} vs ${full.throttle.toFixed(2)}`);
});

test('joystick: it can actually drive the car', () => {
  const g = new Game(23);
  g.start();
  g.car.ang = 0;
  // Hold the stick due south and the car should come round to face that way.
  for (let i = 0; i < 60 * 4; i++) {
    const r = stickToInput(g.car.ang, g.car.speed, 0, 1);
    g.update(STEP, { throttle: r.throttle, steer: r.steer });
  }
  assert.ok(Math.abs(g.car.ang - Math.PI / 2) < 0.3,
    `car should be heading south, is at ${(g.car.ang * 57.3).toFixed(0)} degrees`);
  assert.ok(g.car.speed > 100, 'and moving');
});

// ---------------------------------------------------------------------------
// Wet blood: the fluid, and what it does to the car
// ---------------------------------------------------------------------------

test('fluid: blood flows the way it is pushed, and not the other way', () => {
  const f = new BloodField();
  f.anchor(5000, 5000);
  f.add(5000, 5000, 3, 0, 0, 40);
  for (let i = 0; i < 30; i++) {
    f.addVelocity(5000, 5000, 900, 0, 30);
    f.step(1 / 30);
  }
  const downstream = f.sample(5120, 5000);
  const upstream = f.sample(4880, 5000);
  assert.ok(downstream > 0.01, `blood should be carried downstream, got ${downstream.toFixed(3)}`);
  assert.ok(downstream > upstream * 5, 'and not spread evenly in both directions');
});

test('fluid: a dry road costs nothing, and blood dries up on its own', () => {
  const f = new BloodField();
  f.anchor(0, 0);
  assert.equal(f.empty, true, 'nothing to simulate on clean tarmac');
  f.step(1 / 30);
  assert.equal(f.wet, 0);

  f.add(1000, 1000, 1, 0, 0, 30);
  assert.equal(f.empty, false);
  const fresh = f.wet || 1;
  for (let i = 0; i < 30 * 60; i++) f.step(1 / 30);
  assert.ok(f.wet < fresh * 0.2, `blood should dry over a minute, ${f.wet.toFixed(2)} left`);
});

test('fluid: only the bloody part of the grid is simulated', () => {
  const f = new BloodField();
  f.anchor(5000, 5000);
  f.add(5000, 5000, 1, 0, 0, 30);
  f.step(1 / 30);
  const cells = (f.bi1 - f.bi0 + 1) * (f.bj1 - f.bj0 + 1);
  assert.ok(cells < f.size * 0.05,
    `one splash should not wake the whole grid (${cells} of ${f.size} cells)`);
});

test('fluid: the window follows the car and carries the blood with it', () => {
  const f = new BloodField();
  f.anchor(5000, 5000);
  f.add(5000, 5000, 2, 0, 0, 40);
  const before = f.sample(5000, 5000);
  f.anchor(5600, 5000);   // drive east; the pool must stay where it was spilt
  const after = f.sample(5000, 5000);
  assert.ok(Math.abs(after - before) < 0.05,
    `blood should stay at its world position (${before.toFixed(2)} -> ${after.toFixed(2)})`);

  f.anchor(90000, 90000); // somewhere else entirely
  assert.equal(f.sample(5000, 5000), 0, 'and be gone once it is far out of range');
});

test('blood: killing them makes the road slick under the car', () => {
  const g = new Game(30);
  g.start();
  assert.equal(g.slip, 0, 'the road starts clean');
  for (let i = 0; i < 14; i++) g.blood.add(g.car.x, g.car.y, 0.3, 0, 0, 24);
  g.update(STEP, { throttle: 0, steer: 0 });
  assert.ok(g.slip > 0.5, `a pile of bodies should leave a slick, got ${g.slip.toFixed(2)}`);
});

test('blood: a slick road makes the car slide instead of gripping', () => {
  const drift = (slip) => {
    const c = createCar(0, 0, 0);
    c.gear = GEAR_HIGH;
    c.vx = 420;
    c.speed = 420;
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      updateCar(c, { throttle: 1, steer: 1 }, STEP, { slip });
      let d = Math.atan2(c.vy, c.vx) - c.ang;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      peak = Math.max(peak, Math.abs(d));
    }
    return peak;
  };
  assert.ok(drift(0) < 0.01, 'a dry road gives no slide at all');
  assert.ok(drift(1) > 0.2, `blood should break traction, got ${(drift(1) * 57.3).toFixed(0)} degrees`);
  assert.ok(drift(1) > drift(0.5), 'and more blood should mean more slide');
});

test('blood: low gear can break traction on it, high gear cannot', () => {
  const spin = (gear) => {
    const c = createCar(0, 0, 0);
    c.gear = gear;
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      updateCar(c, { throttle: 1, steer: 0 }, STEP, { slip: 1 });
      peak = Math.max(peak, c.wheelspin);
    }
    return peak;
  };
  assert.ok(spin(GEAR_LOW) > 0.3, 'low gear has the torque to light them up');
  assert.ok(spin(GEAR_HIGH) < spin(GEAR_LOW) * 0.5, 'high gear has not got the torque down low');
});

test('burnout: throttle and brake together spins the tyres on the spot', () => {
  const c = createCar(0, 0, 0);
  c.gear = GEAR_LOW;
  let turned = 0;
  let last = c.ang;
  for (let i = 0; i < 180; i++) {
    updateCar(c, { throttle: 0, steer: 1, burnout: true }, STEP, { slip: 0.9 });
    let d = c.ang - last;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    turned += d;
    last = c.ang;
  }
  assert.ok(c.wheelspin > 0.9, 'the wheels should be spinning');
  assert.ok(Math.abs(turned) > Math.PI * 2, `should spin right round, turned ${(turned * 57.3).toFixed(0)} degrees`);
  assert.ok(Math.hypot(c.x, c.y) < 260, `without going anywhere, moved ${Math.hypot(c.x, c.y).toFixed(0)}px`);
});

test('burnout: it throws the blood about and lays rubber', () => {
  const g = new Game(31);
  g.start();
  g.car.gear = GEAR_LOW;
  for (let i = 0; i < 14; i++) g.blood.add(g.car.x, g.car.y, 0.3, 0, 0, 26);
  g.marks.length = 0;
  run(g, 1.5, { throttle: 0, steer: 1, burnout: true });
  assert.ok(g.car.wheelspin > 0.9, 'wheels spinning');
  assert.ok(g.marks.length > 0, 'a burnout should leave marks on the road');
  assert.ok(g.marks.some((m) => m.blood > 0.3), 'and in a pool of blood they should be bloody ones');
  assert.ok(g.car.tyreBlood > 0.1, 'with blood picked up on the tyres');
});

test('tyres: driving through blood picks it up and trails it away', () => {
  const g = new Game(32);
  g.start();
  g.car.ang = 0;
  g.car.vx = 260;
  g.car.speed = 260;
  // A pool sitting on the road ahead.
  for (let i = 0; i < 10; i++) g.blood.add(g.car.x + 40 + i * 12, g.car.y, 0.45, 0, 0, 26);
  g.marks.length = 0;
  run(g, 1.2, { throttle: 1, steer: 0 });
  assert.ok(g.car.tyreBlood > 0.05, 'the tyres should come away bloody');
  assert.ok(g.marks.length > 0, 'and lay a trail behind them');
});

test('gore: a kill throws off a good deal more than a handful of chunks', () => {
  const g = new Game(33);
  g.start();
  g.car.gear = GEAR_HIGH;
  run(g, 6, { throttle: 1, steer: 0 });
  const before = g.gore.live;
  const kills = g.kills;
  mob(g, 20, 30);
  run(g, 0.5, { throttle: 1, steer: 0 });
  const perKill = (g.gore.live - before) / Math.max(1, g.kills - kills);
  assert.ok(perKill > 6, `expected a proper mess per kill, got ${perKill.toFixed(1)} chunks`);
});
