// A crude road-following driver used by the headless tests. It is not smart -
// it keeps to the middle of a street and turns at random intersections - but
// it is enough to exercise the sim the way a player would.

import { CELL } from '../js/city.js';
import { angleDiff, clamp, mulberry32 } from '../js/util.js';
import { GEAR_LOW, GEAR_HIGH } from '../js/car.js';

const DIRS = [
  [1, 0], [0, 1], [-1, 0], [0, -1],
];

export function createBot(game, seed = 1) {
  // Seeded, so a failing test can always be reproduced.
  return { dir: 3, turnCooldown: 0, stuck: 0, reversing: 0, game, rng: mulberry32(seed >>> 0) };
}

export function botInput(bot, dt) {
  const car = bot.game.car;
  const [dx, dy] = DIRS[bot.dir];
  const vertical = dx === 0;

  bot.turnCooldown -= dt;
  // Near the middle of an intersection? Consider turning.
  const along = vertical ? car.y : car.x;
  const cross = along / CELL;
  if (bot.turnCooldown <= 0 && Math.abs(cross - Math.round(cross)) < 0.04) {
    if (bot.rng() < 0.55) {
      bot.dir = (bot.dir + (bot.rng() < 0.5 ? 1 : 3)) % 4;
      bot.turnCooldown = 1.2;
    }
  }

  const [ndx, ndy] = DIRS[bot.dir];
  // Aim at a point further down the middle of the street we are on.
  const look = 140;
  let tx;
  let ty;
  if (ndx === 0) {
    tx = Math.round(car.x / CELL) * CELL;
    ty = car.y + ndy * look;
  } else {
    tx = car.x + ndx * look;
    ty = Math.round(car.y / CELL) * CELL;
  }
  const desired = Math.atan2(ty - car.y, tx - car.x);
  const steer = clamp(angleDiff(car.ang, desired) * 2.2, -1, 1);

  // The intended strategy: low gear to claw out of a swarm, high to cruise.
  const wantLow = bot.game.crowd > 0.4 || Math.abs(car.speed) < 90;
  bot.game.shiftTo(wantLow ? GEAR_LOW : GEAR_HIGH);

  // Wedged against a building: back up and try again, like a player would.
  if (Math.abs(car.speed) < 25) bot.stuck += dt; else bot.stuck = 0;
  if (bot.stuck > 0.7 && bot.reversing <= 0) bot.reversing = 1.1;
  if (bot.reversing > 0) {
    bot.reversing -= dt;
    return { throttle: -1, steer: -steer };
  }
  return { throttle: 1, steer };
}
