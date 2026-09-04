// Every sprite is drawn once into an offscreen canvas at boot, then blitted
// thousands of times per frame. Sprites face +x, matching an angle of 0.

import { mulberry32, TAU } from './util.js';
import { CAR_LENGTH, CAR_WIDTH } from './car.js';
import { PICKUP_KINDS, WIRE, WHEELS, FLAME } from './pickups.js';

const SS = 2; // supersample factor, for crisp edges on hi-dpi screens

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * SS);
  c.height = Math.ceil(h * SS);
  const ctx = c.getContext('2d');
  ctx.scale(SS, SS);
  c.w = w;
  c.h = h;
  return { canvas: c, ctx };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCar(ctx, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const L = CAR_LENGTH;
  const W = CAR_WIDTH;
  const x = cx - L / 2;
  const y = cy - W / 2;

  // Wheels poking out from under the body.
  ctx.fillStyle = '#14151a';
  for (const [wx, wy] of [[0.30, -0.5], [0.30, 0.5], [-0.30, -0.5], [-0.30, 0.5]]) {
    roundRect(ctx, cx + wx * L - 7, cy + wy * W - 4.5, 14, 9, 3);
    ctx.fill();
  }

  // Body.
  const body = ctx.createLinearGradient(0, y, 0, y + W);
  body.addColorStop(0, '#d94b3f');
  body.addColorStop(0.5, '#b62f27');
  body.addColorStop(1, '#8d1f1c');
  ctx.fillStyle = body;
  roundRect(ctx, x, y, L, W, 7);
  ctx.fill();
  ctx.strokeStyle = '#2b1112';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Racing stripes down the length of the car.
  ctx.fillStyle = 'rgba(240,236,225,0.85)';
  ctx.fillRect(x + 5, cy - 6.5, L - 16, 4);
  ctx.fillRect(x + 5, cy + 2.5, L - 16, 4);

  // Cabin glass.
  ctx.fillStyle = '#1b2430';
  roundRect(ctx, cx - 11, y + 4, 22, W - 8, 5);
  ctx.fill();
  ctx.fillStyle = 'rgba(150,200,240,0.20)';
  roundRect(ctx, cx - 9, y + 5.5, 8, W - 11, 3);
  ctx.fill();

  // Front bumper / push bar - this is the business end.
  ctx.fillStyle = '#3a3d45';
  roundRect(ctx, x + L - 9, y + 1, 8, W - 2, 3);
  ctx.fill();
  ctx.fillStyle = '#5a5f6b';
  ctx.fillRect(x + L - 4, y + 3, 3, W - 6);

  // Lights.
  ctx.fillStyle = '#ffe9a8';
  ctx.fillRect(x + L - 3.5, y + 3.5, 2.5, 5);
  ctx.fillRect(x + L - 3.5, y + W - 8.5, 2.5, 5);
  ctx.fillStyle = '#ff5a4a';
  ctx.fillRect(x + 1, y + 4, 2, 4.5);
  ctx.fillRect(x + 1, y + W - 8.5, 2, 4.5);

  // Rear spoiler.
  ctx.fillStyle = '#2b1112';
  roundRect(ctx, x - 1, y + 2, 4, W - 4, 2);
  ctx.fill();
}

function drawZombie(ctx, w, h, frame, rng) {
  const cx = w / 2;
  const cy = h / 2;
  const swing = Math.sin((frame / 4) * TAU);

  // Contact shadow, so a body still reads when it is standing in gore.
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.beginPath();
  ctx.ellipse(cx - 1, cy + 1, 8, 6.5, 0, 0, TAU);
  ctx.fill();

  const skin = ['#7d9a5e', '#6d8a52', '#88a06a', '#5f7f4c'][Math.floor(rng() * 4)];
  const cloth = ['#3c4a44', '#4a3f38', '#33404d', '#4c4438'][Math.floor(rng() * 4)];

  // Legs, trailing behind and shuffling out of phase.
  ctx.strokeStyle = cloth;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx - 2, cy + s * 3);
    ctx.lineTo(cx - 8, cy + s * 4.5 + swing * s * 2.5);
    ctx.stroke();
  }

  // Torso.
  ctx.fillStyle = cloth;
  ctx.beginPath();
  ctx.ellipse(cx - 1, cy, 7, 6, 0, 0, TAU);
  ctx.fill();

  // Arms reaching forward - the classic silhouette.
  ctx.strokeStyle = skin;
  ctx.lineWidth = 3.4;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx - 1, cy + s * 5);
    ctx.quadraticCurveTo(cx + 5, cy + s * 6, cx + 9.5, cy + s * (3 + swing * s * 1.5));
    ctx.stroke();
  }

  // Head.
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(cx + 3.5, cy, 5.2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(20,30,15,0.55)';
  ctx.beginPath();
  ctx.arc(cx + 6, cy - 1.8, 1.2, 0, TAU);
  ctx.arc(cx + 6, cy + 1.8, 1.2, 0, TAU);
  ctx.fill();

  // A little gore already on the clothes.
  ctx.fillStyle = 'rgba(120,20,22,0.5)';
  ctx.beginPath();
  ctx.arc(cx - 2 + rng() * 4, cy - 2 + rng() * 4, 1.8, 0, TAU);
  ctx.fill();
}

function drawSkeleton(ctx, w, h, frame, rng) {
  const cx = w / 2;
  const cy = h / 2;
  const swing = Math.sin((frame / 4) * TAU);
  // Contact shadow, so a body still reads when it is standing in gore.
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath();
  ctx.ellipse(cx - 1, cy + 1, 7, 5.5, 0, 0, TAU);
  ctx.fill();

  const bone = ['#e2dcc4', '#d5cdb2', '#eae4cf'][Math.floor(rng() * 3)];

  ctx.strokeStyle = bone;
  ctx.lineCap = 'round';

  // Legs.
  ctx.lineWidth = 2.6;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx - 2, cy + s * 2.5);
    ctx.lineTo(cx - 7.5, cy + s * 4 + swing * s * 3);
    ctx.stroke();
  }

  // Ribcage.
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(cx - 3 + i * 2.2, cy - 4.5);
    ctx.lineTo(cx - 3 + i * 2.2, cy + 4.5);
    ctx.stroke();
  }
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy);
  ctx.lineTo(cx + 2, cy);
  ctx.stroke();

  // Clawing arms.
  ctx.lineWidth = 2.2;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx - 1, cy + s * 4);
    ctx.quadraticCurveTo(cx + 4, cy + s * 5.5, cx + 9, cy + s * (2.5 + swing * s * 2));
    ctx.stroke();
  }

  // Skull.
  ctx.fillStyle = bone;
  ctx.beginPath();
  ctx.arc(cx + 3.5, cy, 4.6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#22242a';
  ctx.beginPath();
  ctx.arc(cx + 5.4, cy - 1.7, 1.35, 0, TAU);
  ctx.arc(cx + 5.4, cy + 1.7, 1.35, 0, TAU);
  ctx.fill();
}

function drawMeat(ctx, w, h, rng) {
  const cx = w / 2;
  const cy = h / 2;
  const r = w * 0.38;
  const pts = 9;
  const dark = `hsl(${350 + rng() * 12}, ${52 + rng() * 18}%, ${13 + rng() * 8}%)`;
  const mid = `hsl(${352 + rng() * 10}, ${60 + rng() * 15}%, ${24 + rng() * 9}%)`;

  ctx.beginPath();
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * TAU;
    const rad = r * (0.62 + rng() * 0.55);
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = mid;
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Wet highlight so piles read as glistening rather than flat.
  ctx.fillStyle = 'rgba(255,160,150,0.22)';
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.2, cy - r * 0.25, r * 0.3, r * 0.2, rng() * TAU, 0, TAU);
  ctx.fill();
}

function drawBone(ctx, w, h, rng) {
  const cx = w / 2;
  const cy = h / 2;
  ctx.fillStyle = `hsl(${44 + rng() * 10}, 22%, ${74 + rng() * 12}%)`;
  ctx.strokeStyle = 'rgba(60,50,40,0.5)';
  ctx.lineWidth = 1;
  const len = w * 0.42;
  const th = h * 0.16;
  roundRect(ctx, cx - len, cy - th, len * 2, th * 2, th);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - len, cy, th * 1.5, 0, TAU);
  ctx.arc(cx + len, cy, th * 1.5, 0, TAU);
  ctx.fill();
}

function drawChar(ctx, w, h, rng) {
  const cx = w / 2;
  const cy = h / 2;
  const r = w * 0.36;
  ctx.beginPath();
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * TAU;
    const rad = r * (0.55 + rng() * 0.6);
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = `hsl(${20 + rng() * 14}, ${8 + rng() * 10}%, ${8 + rng() * 7}%)`;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // Embers still glowing in the ash.
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = `hsla(${18 + rng() * 22}, 90%, ${45 + rng() * 20}%, ${0.35 + rng() * 0.4})`;
    ctx.beginPath();
    ctx.arc(cx + (rng() - 0.5) * r, cy + (rng() - 0.5) * r, 0.8 + rng() * 1.4, 0, TAU);
    ctx.fill();
  }
}

/** The crate an upgrade sits in, with its own icon on the lid. */
function drawPickup(ctx, w, h, kind) {
  const cx = w / 2;
  const cy = h / 2;
  const colour = PICKUP_KINDS[kind].colour;
  const box = 26;

  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  roundRect(ctx, cx - box / 2 + 3, cy - box / 2 + 5, box, box, 4);
  ctx.fill();

  ctx.fillStyle = '#23252c';
  roundRect(ctx, cx - box / 2, cy - box / 2, box, box, 4);
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';

  if (kind === WIRE) {
    // A coil of wire seen end-on, with barbs.
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 4.5, Math.sin(a) * 4.5);
      ctx.lineTo(Math.cos(a) * 10, Math.sin(a) * 10);
      ctx.stroke();
    }
  } else if (kind === WHEELS) {
    // A fat tyre with tread blocks.
    ctx.beginPath();
    ctx.arc(0, 0, 8.5, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 3.4, 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 6, Math.sin(a) * 6);
      ctx.lineTo(Math.cos(a) * 8.5, Math.sin(a) * 8.5);
      ctx.stroke();
    }
  } else {
    // A flame.
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.quadraticCurveTo(7, -2, 4.5, 4);
    ctx.quadraticCurveTo(3, 9, 0, 10);
    ctx.quadraticCurveTo(-3, 9, -4.5, 4);
    ctx.quadraticCurveTo(-7, -2, 0, -10);
    ctx.fill();
    ctx.fillStyle = '#2a1206';
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.quadraticCurveTo(3, 2, 1.5, 6);
    ctx.quadraticCurveTo(0, 8, -1.5, 6);
    ctx.quadraticCurveTo(-3, 2, 0, -2);
    ctx.fill();
  }
  ctx.restore();
}

/** Oversized tyres, drawn underneath the car while the upgrade is running. */
function drawBigWheels(ctx, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const off = CAR_WIDTH * 0.5 * 1.75;
  ctx.fillStyle = '#101116';
  ctx.strokeStyle = '#2e3038';
  ctx.lineWidth = 1.5;
  for (const sx of [0.30, -0.30]) {
    for (const sy of [1, -1]) {
      const x = cx + sx * CAR_LENGTH - 11;
      const y = cy + sy * off - 8;
      roundRect(ctx, x, y, 22, 16, 5);
      ctx.fill();
      ctx.stroke();
      // Tread.
      ctx.strokeStyle = 'rgba(150,155,170,0.30)';
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(x + 3 + i * 5, y + 2);
        ctx.lineTo(x + 3 + i * 5, y + 14);
        ctx.stroke();
      }
      ctx.strokeStyle = '#2e3038';
    }
  }
}

/** Barbed wire wrapped round the bodywork, drawn over the car. */
function drawWire(ctx, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const L = CAR_LENGTH;
  const W = CAR_WIDTH;
  ctx.strokeStyle = '#cfe0e8';
  ctx.lineWidth = 1.6;
  roundRect(ctx, cx - L / 2 - 1, cy - W / 2 - 1, L + 2, W + 2, 8);
  ctx.stroke();

  // Barbs round the perimeter.
  ctx.lineWidth = 1.3;
  const barbs = 22;
  for (let i = 0; i < barbs; i++) {
    const t = i / barbs;
    let x;
    let y;
    let nx;
    let ny;
    if (t < 0.5) {
      x = cx - L / 2 + L * (t * 2);
      y = cy - W / 2 - 1;
      nx = 0;
      ny = -1;
    } else {
      x = cx + L / 2 - L * ((t - 0.5) * 2);
      y = cy + W / 2 + 1;
      nx = 0;
      ny = 1;
    }
    ctx.beginPath();
    ctx.moveTo(x - 2.5, y - ny * 1.5);
    ctx.lineTo(x + 2.5, y + ny * 3.5);
    ctx.moveTo(x + 2.5, y - ny * 1.5);
    ctx.lineTo(x - 2.5, y + ny * 3.5);
    ctx.stroke();
  }
  // And across the nose, where most of the shredding happens.
  for (let i = 0; i < 4; i++) {
    const y = cy - W / 2 + 4 + i * ((W - 8) / 3);
    ctx.beginPath();
    ctx.moveTo(cx + L / 2 - 2, y - 2.5);
    ctx.lineTo(cx + L / 2 + 4, y + 2.5);
    ctx.moveTo(cx + L / 2 + 4, y - 2.5);
    ctx.lineTo(cx + L / 2 - 2, y + 2.5);
    ctx.stroke();
  }
}

export function makeSprites() {
  const rng = mulberry32(1337);

  const carPad = 10;
  const car = makeCanvas(CAR_LENGTH + carPad * 2, CAR_WIDTH + carPad * 2);
  drawCar(car.ctx, car.canvas.w, car.canvas.h);

  const ENEMY = 30;
  const zombies = [];
  const skeletons = [];
  for (let f = 0; f < 4; f++) {
    const z = makeCanvas(ENEMY, ENEMY);
    drawZombie(z.ctx, ENEMY, ENEMY, f, mulberry32(90 + f));
    zombies.push(z.canvas);

    const s = makeCanvas(ENEMY, ENEMY);
    drawSkeleton(s.ctx, ENEMY, ENEMY, f, mulberry32(300 + f));
    skeletons.push(s.canvas);
  }

  // A handful of variants each, picked per chunk so piles are not repetitive.
  const meat = [];
  const bone = [];
  for (let i = 0; i < 6; i++) {
    const m = makeCanvas(32, 32);
    drawMeat(m.ctx, 32, 32, mulberry32(500 + i));
    meat.push(m.canvas);

    const b = makeCanvas(24, 24);
    drawBone(b.ctx, 24, 24, mulberry32(700 + i));
    bone.push(b.canvas);
  }

  const char = [];
  for (let i = 0; i < 6; i++) {
    const c = makeCanvas(26, 26);
    drawChar(c.ctx, 26, 26, mulberry32(900 + i));
    char.push(c.canvas);
  }

  const pickups = [];
  for (let k = 0; k < PICKUP_KINDS.length; k++) {
    const c = makeCanvas(44, 44);
    drawPickup(c.ctx, 44, 44, k);
    pickups.push(c.canvas);
  }

  const wheelPad = 14;
  const bigWheels = makeCanvas(CAR_LENGTH + carPad * 2, CAR_WIDTH * 1.75 + wheelPad * 2);
  drawBigWheels(bigWheels.ctx, bigWheels.canvas.w, bigWheels.canvas.h);

  const wire = makeCanvas(CAR_LENGTH + carPad * 2, CAR_WIDTH + carPad * 2);
  drawWire(wire.ctx, wire.canvas.w, wire.canvas.h);

  return {
    car: car.canvas,
    zombies, skeletons, meat, bone, char,
    pickups,
    bigWheels: bigWheels.canvas,
    wire: wire.canvas,
    enemySize: ENEMY,
    rng,
  };
}
