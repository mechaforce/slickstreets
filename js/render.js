// All drawing lives here. The simulation never touches the canvas.

import { CELL, ROAD } from './city.js';
import { CAR_LENGTH, CAR_WIDTH, GEARS, GEAR_LOW, GEAR_HIGH, KMH_PER_PX, PX_PER_METRE } from './car.js';
import { ZOMBIE } from './enemies.js';
import { MEAT, BONE } from './gore.js';
import { MAX_HEALTH } from './game.js';
import { PICKUP_KINDS, PICKUP_RADIUS, WIRE, WHEELS, FLAME } from './pickups.js';
import { STICK_RADIUS } from './touch.js';
import { clamp, lerp, TAU, mulberry32 } from './util.js';

const ROAD_COLOR = '#26272d';
const SIDEWALK = '#41434c';
const PARK = '#2c3b2b';
const LOT = '#313239';
const LINE = 'rgba(206,180,88,0.55)';

const TILE_WORLD = 1024;   // world units covered by one decal tile
const TILE_PX = 512;       // half-resolution: blood does not need to be sharp
const MAX_TILES = 28;

/**
 * Persistent blood staining, baked into a sparse grid of offscreen tiles so
 * the trail you carve through the city survives long after the chunks that
 * made it have been recycled.
 */
class DecalLayer {
  constructor() {
    this.tiles = new Map();
    this.rng = mulberry32(4242);
  }

  clear() {
    this.tiles.clear();
  }

  _tile(tx, ty, frame) {
    const key = tx * 8192 + ty;
    let t = this.tiles.get(key);
    if (t === undefined) {
      if (this.tiles.size >= MAX_TILES) {
        // Drop whichever tile has gone unseen the longest.
        let oldest = null;
        let oldestFrame = Infinity;
        for (const [k, v] of this.tiles) {
          if (v.seen < oldestFrame) { oldestFrame = v.seen; oldest = k; }
        }
        if (oldest !== null) this.tiles.delete(oldest);
      }
      const canvas = document.createElement('canvas');
      canvas.width = TILE_PX;
      canvas.height = TILE_PX;
      const ctx = canvas.getContext('2d');
      const s = TILE_PX / TILE_WORLD;
      ctx.setTransform(s, 0, 0, s, -tx * TILE_WORLD * s, -ty * TILE_WORLD * s);
      t = { canvas, ctx, seen: frame };
      this.tiles.set(key, t);
    }
    t.seen = frame;
    return t;
  }

  /** Paint one kill's stain into every tile it touches. */
  splat(s, frame) {
    const rng = this.rng;
    const r = s.r;
    const x0 = Math.floor((s.x - r) / TILE_WORLD);
    const x1 = Math.floor((s.x + r) / TILE_WORLD);
    const y0 = Math.floor((s.y - r) / TILE_WORLD);
    const y1 = Math.floor((s.y + r) / TILE_WORLD);

    // Same shape drawn into each overlapping tile, so seams do not show.
    const blobs = [];
    const n = 5 + Math.floor(rng() * 5);
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU;
      const d = rng() * r * 0.55;
      blobs.push([s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, r * (0.22 + rng() * 0.42)]);
    }
    const streaks = [];
    const sn = 4 + Math.floor(rng() * 6);
    for (let i = 0; i < sn; i++) {
      const spread = (rng() - 0.5) * 1.1;
      const dist = r * (0.6 + rng() * 2.2) * (0.4 + s.power / 500);
      const ca = Math.cos(spread);
      const sa = Math.sin(spread);
      const dx = s.dirx * ca - s.diry * sa;
      const dy = s.dirx * sa + s.diry * ca;
      streaks.push([s.x + dx * dist, s.y + dy * dist, r * (0.07 + rng() * 0.16)]);
    }

    // Blood, bone dust, or the black scorch the flamethrower leaves.
    const scorch = s.kind !== MEAT && s.kind !== BONE;
    const bone = s.kind === BONE;
    const hue = scorch ? 24 : bone ? 40 : 356;
    const sat = scorch ? 12 : bone ? 18 : 62;
    const light = scorch ? 6 : bone ? 60 : 15 + s.tone * 8;

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = this._tile(tx, ty, frame);
        const ctx = t.ctx;
        ctx.fillStyle = `hsla(${hue}, ${sat}%, ${light}%, ${bone ? 0.28 : scorch ? 0.55 : 0.5})`;
        for (const [bx, by, br] of blobs) {
          ctx.beginPath();
          ctx.arc(bx, by, br, 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = `hsla(${hue}, ${sat}%, ${light + 4}%, ${bone ? 0.2 : scorch ? 0.4 : 0.38})`;
        for (const [sx, sy, sr] of streaks) {
          ctx.beginPath();
          ctx.arc(sx, sy, sr, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  draw(ctx, view, frame) {
    const x0 = Math.floor(view.x / TILE_WORLD);
    const x1 = Math.floor((view.x + view.w) / TILE_WORLD);
    const y0 = Math.floor(view.y / TILE_WORLD);
    const y1 = Math.floor((view.y + view.h) / TILE_WORLD);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = this.tiles.get(tx * 8192 + ty);
        if (t === undefined) continue;
        t.seen = frame;
        ctx.drawImage(t.canvas, tx * TILE_WORLD, ty * TILE_WORLD, TILE_WORLD, TILE_WORLD);
      }
    }
  }
}

export class Renderer {
  constructor(canvas, sprites) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.sprites = sprites;
    this.decals = new DecalLayer();
    this.cam = { x: 0, y: 0, zoom: 1.12 };
    this.dpr = 1;
    this.frame = 0;
    this.hurtFlash = 0;
    this.shiftHint = 0;
    this.view = { x: 0, y: 0, w: 0, h: 0 };
    this.gradients = null;
    this._pickupQ = [];
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    // The HUD is laid out in its own units and scaled down on small screens,
    // so a phone gets the same furniture without it swallowing the view.
    this.uiScale = clamp(Math.min(w / 1180, h / 700), 0.7, 1);
    this.uw = w / this.uiScale;
    this.uh = h / this.uiScale;
    this.gradients = null; // rebuilt lazily at the new size
  }

  _gradients() {
    if (this.gradients !== null) return this.gradients;
    const ctx = this.ctx;
    const W = this.uw;
    const H = this.uh;
    const vignette = ctx.createRadialGradient(
      W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    // Danger wash is drawn at full strength and faded with globalAlpha.
    const danger = ctx.createRadialGradient(
      W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.62);
    danger.addColorStop(0, 'rgba(140,0,0,0)');
    danger.addColorStop(1, 'rgba(140,0,0,1)');
    this.gradients = { vignette, danger };
    return this.gradients;
  }

  reset() {
    this.decals.clear();
  }

  /** Camera chases the car with a lead in the direction of travel. */
  updateCamera(game, dt) {
    const car = game.car;
    const speed = Math.hypot(car.vx, car.vy);
    const lead = clamp(speed * 0.35, 0, 190);
    const tx = car.x + Math.cos(car.ang) * lead;
    const ty = car.y + Math.sin(car.ang) * lead;
    const k = 1 - Math.exp(-6 * dt);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;

    // Pull back a little as you gain speed so you can see what you are hitting.
    const targetZoom = 1.12 - 0.24 * clamp(speed / 660, 0, 1);
    this.cam.zoom += (targetZoom - this.cam.zoom) * (1 - Math.exp(-3 * dt));
  }

  /** Set the canvas transform to world space, including shake. */
  worldTransform(game) {
    const z = this.cam.zoom * this.dpr;
    const shake = game.shake;
    const sx = shake > 0.01 ? (Math.random() - 0.5) * shake * 2 : 0;
    const sy = shake > 0.01 ? (Math.random() - 0.5) * shake * 2 : 0;
    this.ctx.setTransform(
      z, 0, 0, z,
      (this.w * 0.5 + sx) * this.dpr - this.cam.x * z,
      (this.h * 0.5 + sy) * this.dpr - this.cam.y * z,
    );
  }

  computeView() {
    const halfW = this.w / (2 * this.cam.zoom);
    const halfH = this.h / (2 * this.cam.zoom);
    const m = 90;
    this.view.x = this.cam.x - halfW - m;
    this.view.y = this.cam.y - halfH - m;
    this.view.w = halfW * 2 + m * 2;
    this.view.h = halfH * 2 + m * 2;
    return this.view;
  }

  render(game, dt) {
    this.frame++;
    this.updateCamera(game, dt);
    const ctx = this.ctx;
    const view = this.computeView();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = ROAD_COLOR;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.worldTransform(game);
    this.drawGround(game, view);
    for (const s of game.gore.splats) this.decals.splat(s, this.frame);
    game.gore.splats.length = 0;
    this.decals.draw(ctx, view, this.frame);
    this.drawGore(game, view);
    this.drawPickups(game, view);
    this.drawFlame(game);
    this.drawParticles(game, view);
    this.drawEnemies(game, view);
    this.drawCar(game);
    this.drawBuildings(game, view);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(this.dpr * this.uiScale, this.dpr * this.uiScale);
    this.drawHud(game, dt);
  }

  // ---- world ------------------------------------------------------------

  drawGround(game, view) {
    const ctx = this.ctx;
    const city = game.city;
    const c0x = Math.max(0, Math.floor(view.x / CELL));
    const c1x = Math.min(city.cols - 1, Math.floor((view.x + view.w) / CELL));
    const c0y = Math.max(0, Math.floor(view.y / CELL));
    const c1y = Math.min(city.rows - 1, Math.floor((view.y + view.h) / CELL));

    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const b = city.blocks[cy * city.cols + cx];
        if (b === undefined) continue;
        ctx.fillStyle = SIDEWALK;
        ctx.fillRect(b.x - 10, b.y - 10, b.w + 20, b.h + 20);
        ctx.fillStyle = b.type === 'park' ? PARK : b.type === 'lot' ? LOT : '#3a3c44';
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
    }

    // Lane markings down the middle of each street.
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 3;
    ctx.setLineDash([26, 22]);
    ctx.beginPath();
    for (let cx = c0x; cx <= c1x + 1; cx++) {
      const x = cx * CELL;
      ctx.moveTo(x, Math.max(0, view.y));
      ctx.lineTo(x, Math.min(city.height, view.y + view.h));
    }
    for (let cy = c0y; cy <= c1y + 1; cy++) {
      const y = cy * CELL;
      ctx.moveTo(Math.max(0, view.x), y);
      ctx.lineTo(Math.min(city.width, view.x + view.w), y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Crosswalk stripes on the approaches to each intersection.
    ctx.fillStyle = 'rgba(220,220,220,0.16)';
    const half = ROAD * 0.5;
    for (let cy = c0y; cy <= c1y + 1; cy++) {
      for (let cx = c0x; cx <= c1x + 1; cx++) {
        const ix = cx * CELL;
        const iy = cy * CELL;
        for (let i = 0; i < 5; i++) {
          const o = -half + 12 + i * 26;
          ctx.fillRect(ix + o, iy - half - 16, 16, 12);
          ctx.fillRect(ix + o, iy + half + 4, 16, 12);
          ctx.fillRect(ix - half - 16, iy + o, 12, 16);
          ctx.fillRect(ix + half + 4, iy + o, 12, 16);
        }
      }
    }
  }

  drawBuildings(game, view) {
    const ctx = this.ctx;
    const city = game.city;
    const c0x = Math.max(-1, Math.floor(view.x / CELL));
    const c1x = Math.min(city.cols, Math.floor((view.x + view.w) / CELL));
    const c0y = Math.max(-1, Math.floor(view.y / CELL));
    const c1y = Math.min(city.rows, Math.floor((view.y + view.h) / CELL));
    const cam = this.cam;

    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const list = city.grid.get(cx * 8192 + cy);
        if (list === undefined) continue;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          const mx = s.x + s.w * 0.5;
          const my = s.y + s.h * 0.5;
          // Fake parallax extrusion: taller things lean further from centre.
          // Clamped to the footprint so a narrow building's roof still sits on
          // its own walls instead of sliding off like a dropped card.
          const k = s.top / 1050;
          const dx = clamp((mx - cam.x) * k, -s.w * 0.42, s.w * 0.42);
          const dy = clamp((my - cam.y) * k, -s.h * 0.42, s.h * 0.42);

          if (s.kind === 'tree') {
            const r = s.w * 0.5;
            ctx.fillStyle = 'rgba(0,0,0,0.30)';
            ctx.beginPath();
            ctx.arc(mx + dx * 0.6 + 9, my + dy * 0.6 + 12, r, 0, TAU);
            ctx.fill();
            ctx.fillStyle = s.wall;
            ctx.beginPath();
            ctx.arc(mx + dx * 0.5, my + dy * 0.5, r * 0.95, 0, TAU);
            ctx.fill();
            ctx.fillStyle = s.roof;
            ctx.beginPath();
            ctx.arc(mx + dx, my + dy, r * 0.8, 0, TAU);
            ctx.fill();
            continue;
          }

          ctx.fillStyle = 'rgba(0,0,0,0.32)';
          ctx.fillRect(s.x + dx * 0.5 + 10, s.y + dy * 0.5 + 13, s.w, s.h);

          ctx.fillStyle = s.wall;
          ctx.fillRect(s.x, s.y, s.w, s.h);

          ctx.fillStyle = s.roof;
          ctx.fillRect(s.x + dx, s.y + dy, s.w, s.h);

          if (s.kind === 'building') {
            ctx.strokeStyle = 'rgba(0,0,0,0.35)';
            ctx.lineWidth = 2;
            ctx.strokeRect(s.x + dx + 1, s.y + dy + 1, s.w - 2, s.h - 2);
            if (s.w > 70 && s.h > 70) {
              ctx.fillStyle = 'rgba(0,0,0,0.16)';
              ctx.fillRect(s.x + dx + s.w * 0.22, s.y + dy + s.h * 0.22, s.w * 0.3, s.h * 0.22);
            }
          }
        }
      }
    }
  }

  drawEnemies(game, view) {
    const ctx = this.ctx;
    const sp = this.sprites;
    const size = sp.enemySize;
    const half = size * 0.5;
    const z = this.cam.zoom * this.dpr;
    const ox = (this.w * 0.5) * this.dpr - this.cam.x * z;
    const oy = (this.h * 0.5) * this.dpr - this.cam.y * z;
    const list = game.swarm.active;
    const vx0 = view.x;
    const vy0 = view.y;
    const vx1 = view.x + view.w;
    const vy1 = view.y + view.h;

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.x < vx0 || e.x > vx1 || e.y < vy0 || e.y > vy1) continue;
      const frames = e.kind === ZOMBIE ? sp.zombies : sp.skeletons;
      const img = frames[(e.phase * 1.4 | 0) & 3];
      const cos = Math.cos(e.ang);
      const sin = Math.sin(e.ang);
      ctx.setTransform(
        z * cos, z * sin, -z * sin, z * cos,
        e.x * z + ox, e.y * z + oy,
      );
      ctx.drawImage(img, -half, -half, size, size);
    }
    this.worldTransform(game);
  }

  drawGore(game, view) {
    const ctx = this.ctx;
    const sp = this.sprites;
    const z = this.cam.zoom * this.dpr;
    const ox = (this.w * 0.5) * this.dpr - this.cam.x * z;
    const oy = (this.h * 0.5) * this.dpr - this.cam.y * z;
    const chunks = game.gore.chunks;
    const vx0 = view.x;
    const vy0 = view.y;
    const vx1 = view.x + view.w;
    const vy1 = view.y + view.h;

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (!c.live) continue;
      if (c.x < vx0 || c.x > vx1 || c.y < vy0 || c.y > vy1) continue;
      const set = c.type === MEAT ? sp.meat : c.type === BONE ? sp.bone : sp.char;
      const img = set[c.shape % set.length];
      const s = c.r * 3.0;
      const cos = Math.cos(c.rot);
      const sin = Math.sin(c.rot);
      ctx.setTransform(
        z * cos, z * sin, -z * sin, z * cos,
        c.x * z + ox, c.y * z + oy,
      );
      ctx.drawImage(img, -s * 0.5, -s * 0.5, s, s);
    }
    this.worldTransform(game);
  }

  drawPickups(game, view) {
    const ctx = this.ctx;
    const sp = this.sprites;
    const list = game.pickups.nearby(
      view.x + view.w * 0.5, view.y + view.h * 0.5,
      Math.max(view.w, view.h) * 0.5 + CELL, this._pickupQ,
    );
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.alive) continue;
      if (p.x < view.x || p.x > view.x + view.w || p.y < view.y || p.y > view.y + view.h) continue;
      const kind = PICKUP_KINDS[p.kind];
      const pulse = 0.5 + 0.5 * Math.sin(p.phase);

      // A glow on the tarmac so a crate is spottable down a long street.
      ctx.save();
      ctx.globalAlpha = 0.16 + pulse * 0.16;
      ctx.fillStyle = kind.colour;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PICKUP_RADIUS + 12 + pulse * 5, 0, TAU);
      ctx.fill();
      ctx.restore();

      const img = sp.pickups[p.kind];
      const bob = Math.sin(p.phase) * 2;
      ctx.drawImage(img, p.x - img.w * 0.5, p.y - img.h * 0.5 + bob, img.w, img.h);
    }
  }

  drawFlame(game) {
    if (game.flameSpray <= 0) return;
    const ctx = this.ctx;
    const car = game.car;
    const cos = Math.cos(car.ang);
    const sin = Math.sin(car.ang);
    const mx = car.x + cos * CAR_LENGTH * 0.5;
    const my = car.y + sin * CAR_LENGTH * 0.5;
    // Flicker the reach and spread a little so the jet never looks like a
    // static triangle stuck to the bumper.
    const flick = 0.86 + 0.1 * Math.sin(this.frame * 0.9) + Math.random() * 0.08;
    const range = 205 * flick;
    const half = 0.44 * (0.92 + Math.random() * 0.14);

    const g = ctx.createRadialGradient(mx, my, 6, mx, my, range);
    g.addColorStop(0, 'rgba(255,248,214,0.85)');
    g.addColorStop(0.28, 'rgba(255,164,48,0.55)');
    g.addColorStop(0.7, 'rgba(214,68,20,0.22)');
    g.addColorStop(1, 'rgba(120,24,8,0)');

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.arc(mx, my, range, car.ang - half, car.ang + half);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawParticles(game, view) {
    const ctx = this.ctx;
    const arr = game.particles;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (!p.live) continue;
      if (p.x < view.x || p.x > view.x + view.w || p.y < view.y || p.y > view.y + view.h) continue;
      const a = clamp(p.life / p.max, 0, 1);
      if (p.kind === 0) ctx.fillStyle = `hsla(356, 70%, ${22 + p.tone * 14}%, ${a})`;
      else if (p.kind === 1) ctx.fillStyle = `hsla(44, 20%, ${72 + p.tone * 12}%, ${a})`;
      else if (p.kind === 3) {
        // Fire cools from white-yellow through orange to a dull red as it dies.
        ctx.fillStyle = `hsla(${8 + a * 46}, 100%, ${34 + a * 44}%, ${0.35 + a * 0.65})`;
      } else if (p.kind === 4) {
        ctx.fillStyle = `hsla(24, 6%, ${28 + p.tone * 14}%, ${a * 0.4})`;
      } else ctx.fillStyle = `hsla(38, 95%, ${60 + p.tone * 25}%, ${a})`;
      const s = p.size * (p.kind === 4 ? 1.4 - a * 0.5 : 0.5 + a * 0.7);
      ctx.fillRect(p.x - s * 0.5, p.y - s * 0.5, s, s);
    }
  }

  drawCar(game) {
    const ctx = this.ctx;
    const car = game.car;
    const img = this.sprites.car;
    const z = this.cam.zoom * this.dpr;
    const ox = (this.w * 0.5) * this.dpr - this.cam.x * z;
    const oy = (this.h * 0.5) * this.dpr - this.cam.y * z;
    const cos = Math.cos(car.ang);
    const sin = Math.sin(car.ang);

    ctx.setTransform(z * cos, z * sin, -z * sin, z * cos, car.x * z + ox, car.y * z + oy);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(-CAR_LENGTH * 0.5 + 5, -CAR_WIDTH * 0.5 + 7, CAR_LENGTH, CAR_WIDTH);

    if (game.has(WHEELS)) {
      const bw = this.sprites.bigWheels;
      ctx.drawImage(bw, -bw.w * 0.5, -bw.h * 0.5, bw.w, bw.h);
    }
    ctx.drawImage(img, -img.w * 0.5, -img.h * 0.5, img.w, img.h);
    if (game.has(WIRE)) {
      const wr = this.sprites.wire;
      ctx.drawImage(wr, -wr.w * 0.5, -wr.h * 0.5, wr.w, wr.h);
    }
    this.worldTransform(game);
  }

  // ---- hud ---------------------------------------------------------------

  drawHud(game, dt) {
    const ctx = this.ctx;
    const W = this.uw;
    const H = this.uh;

    for (const ev of game.events) {
      if (ev.type === 'hurt') this.hurtFlash = Math.min(1, this.hurtFlash + ev.amount * dt * 0.12);
      if (ev.type === 'crash') this.hurtFlash = Math.min(1, this.hurtFlash + 0.35);
    }
    this.hurtFlash *= Math.exp(-2.2 * dt);

    // Vignette, plus a red wash while they are on you.
    const grad = this._gradients();
    ctx.fillStyle = grad.vignette;
    ctx.fillRect(0, 0, W, H);

    // Kept to the edges of the screen: you still need to see what you are driving at.
    const danger = Math.max(this.hurtFlash, game.grabbers > 0 ? clamp(game.grabbers / 18, 0, 0.6) : 0);
    if (danger > 0.01) {
      ctx.save();
      ctx.globalAlpha = danger * 0.45;
      ctx.fillStyle = grad.danger;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    if (game.state === 'title') { this.drawTitle(game); return; }
    if (game.state === 'dead') { this.drawGameOver(game); return; }

    this.drawStats(game);
    this.drawSpeedo(game, dt);
    this.drawPressure(game, dt);
    this.drawUpgrades(game);
    this.drawPickupToast(game);
    this.drawMinimap(game);
    this.drawTouch(game);

    if (game.combo >= 3) {
      const pop = clamp(game.comboTimer / 1.4, 0, 1);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.globalAlpha = 0.3 + pop * 0.7;
      ctx.fillStyle = '#ffd166';
      ctx.font = `700 ${34 + game.combo * 0.35}px Impact, "Arial Narrow", sans-serif`;
      ctx.fillText(`${game.combo} SPLATTERED`, W / 2, 92);
      ctx.restore();
    }
  }

  drawStats(game) {
    const ctx = this.ctx;
    const x = 24;
    let y = 34;

    ctx.textAlign = 'left';
    ctx.font = '600 12px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('CHASSIS', x, y - 14);

    const w = 250;
    const hp = game.health / MAX_HEALTH;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x - 2, y - 2, w + 4, 18);
    ctx.fillStyle = hp > 0.5 ? '#5fd07a' : hp > 0.25 ? '#e8c04a' : '#e05252';
    ctx.fillRect(x, y, w * hp, 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (w / 10) * i, y);
      ctx.lineTo(x + (w / 10) * i, y + 14);
      ctx.stroke();
    }

    y += 42;
    const killText = `${game.kills}`;
    ctx.font = '700 26px Impact, "Arial Narrow", sans-serif';
    ctx.fillStyle = '#f2efe6';
    ctx.fillText(killText, x, y);
    const killWidth = ctx.measureText(killText).width;
    ctx.font = '600 12px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('RUN OVER', x + killWidth + 10, y);

    y += 22;
    const mins = Math.floor(game.time / 60);
    const secs = Math.floor(game.time % 60);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(`TIME ${mins}:${secs.toString().padStart(2, '0')}`, x, y);
    y += 18;
    ctx.fillText(`SCORE ${game.totalScore}`, x, y);
    y += 18;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(`HORDE ${game.swarm.count}`, x, y);
  }

  get touchOn() {
    return this.touch !== undefined && this.touch !== null && this.touch.enabled;
  }

  drawSpeedo(game, dt) {
    const ctx = this.ctx;
    // On touch the bottom corners belong to the thumbs, so the dial moves to
    // the middle and drops the gear caption - the gear button says it instead.
    const compact = this.touchOn;
    const cx = compact ? this.uw / 2 : 96;
    const cy = compact ? this.uh - 76 : this.uh - 96;
    const r = compact ? 46 : 62;
    const car = game.car;
    const speed = Math.abs(car.speed);
    const maxAll = GEARS[GEAR_HIGH].maxSpeed;

    ctx.save();
    ctx.translate(cx, cy);

    ctx.fillStyle = 'rgba(10,11,14,0.72)';
    ctx.beginPath();
    ctx.arc(0, 0, r + 8, 0, TAU);
    ctx.fill();

    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;

    // Redline segment for whatever the current gear cannot pull past.
    const gearMax = GEARS[car.gear].maxSpeed / maxAll;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(0, 0, r - 6, a0, a1);
    ctx.stroke();
    ctx.strokeStyle = car.gear === GEAR_LOW ? 'rgba(255,176,64,0.85)' : 'rgba(90,200,255,0.85)';
    ctx.beginPath();
    ctx.arc(0, 0, r - 6, a0, a0 + (a1 - a0) * clamp(speed / maxAll, 0, 1));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,80,80,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r + 1, a0 + (a1 - a0) * gearMax, a1);
    ctx.stroke();

    ctx.fillStyle = '#f4f1e8';
    ctx.textAlign = 'center';
    ctx.font = '700 30px Impact, "Arial Narrow", sans-serif';
    ctx.fillText(`${Math.round(speed * KMH_PER_PX)}`, 0, 2);
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('KM/H', 0, 16);

    // Gear. On touch this lives on the button under the right thumb.
    const low = car.gear === GEAR_LOW;
    if (!compact) {
      ctx.font = '700 22px Impact, "Arial Narrow", sans-serif';
      ctx.fillStyle = low ? '#ffb040' : '#5ac8ff';
      ctx.fillText(low ? 'LOW' : 'HIGH', 0, r + 4);
      ctx.font = '600 9px ui-monospace, Menlo, monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText('SHIFT · SPACE', 0, r + 18);
    }
    ctx.restore();

    // Prompt when high gear is about to get you killed.
    const bogged = game.crowd > 0.45 && car.gear === GEAR_HIGH && speed < 190;
    this.shiftHint = bogged
      ? Math.min(1, this.shiftHint + dt * 4)
      : Math.max(0, this.shiftHint - dt * 4);
    if (this.shiftHint > 0.01) {
      ctx.save();
      ctx.globalAlpha = this.shiftHint * (0.65 + 0.35 * Math.sin(this.frame * 0.25));
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffb040';
      ctx.font = '700 30px Impact, "Arial Narrow", sans-serif';
      ctx.fillText('SHIFT DOWN', this.uw / 2, this.uh - (this.touchOn ? 196 : 132));
      ctx.restore();
    }
  }

  drawPressure(game, dt) {
    const ctx = this.ctx;
    const w = 320;
    const x = this.uw / 2 - w / 2;
    const y = this.uh - (this.touchOn ? 152 : 58);
    const p = clamp(game.crowd, 0, 1);

    ctx.fillStyle = 'rgba(10,11,14,0.7)';
    ctx.fillRect(x - 3, y - 3, w + 6, 20);
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#5fd07a');
    g.addColorStop(0.5, '#e8c04a');
    g.addColorStop(1, '#e05252');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w * p, 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 3, y - 3, w + 6, 20);

    ctx.textAlign = 'center';
    ctx.font = '600 11px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('SWARM PRESSURE', this.uw / 2, y - 8);
  }

  /** Chips in the top-right for whatever is currently bolted to the car. */
  drawUpgrades(game) {
    const ctx = this.ctx;
    const w = 186;
    const x = this.uw - w - 22;
    // Under the minimap when touch has moved it up into the corner.
    let y = this.touchOn ? 160 : 24;

    for (let kind = 0; kind < PICKUP_KINDS.length; kind++) {
      const left = game.power[kind];
      if (left <= 0) continue;
      const def = PICKUP_KINDS[kind];
      const frac = clamp(left / def.duration, 0, 1);
      // Flash the chip when it is nearly out.
      const dying = left < 5 ? 0.45 + 0.55 * Math.abs(Math.sin(this.frame * 0.2)) : 1;

      ctx.save();
      ctx.globalAlpha = dying;
      ctx.fillStyle = 'rgba(10,11,14,0.78)';
      ctx.fillRect(x, y, w, 34);
      ctx.fillStyle = def.colour;
      ctx.fillRect(x, y, 4, 34);

      ctx.textAlign = 'left';
      ctx.font = '600 12px ui-monospace, Menlo, monospace';
      ctx.fillStyle = def.colour;
      ctx.fillText(def.name, x + 12, y + 15);

      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(`${Math.ceil(left)}s`, x + w - 10, y + 15);

      // Time remaining.
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x + 12, y + 22, w - 24, 5);
      ctx.fillStyle = def.colour;
      ctx.fillRect(x + 12, y + 22, (w - 24) * frac, 5);

      // The flamethrower also shows how long until the next burst.
      if (kind === FLAME) {
        const ready = 1 - clamp(game.flameCooldown / 5, 0, 1);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(x + 12, y + 29, (w - 24) * ready, 2);
      }
      ctx.restore();
      y += 42;
    }
  }

  /** The joystick and the gear button, drawn only when touch is in use. */
  drawTouch(game) {
    if (!this.touchOn) return;
    const ctx = this.ctx;
    const t = this.touch;
    const st = t.stick;
    const low = game.car.gear === GEAR_LOW;
    const gearColour = low ? '#ffb040' : '#5ac8ff';

    // Joystick: dimmed at rest, lit while your thumb is on it.
    const live = st.down;
    ctx.save();
    ctx.globalAlpha = live ? 0.9 : 0.4;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(242,239,230,0.5)';
    ctx.fillStyle = 'rgba(8,9,12,0.42)';
    ctx.beginPath();
    ctx.arc(st.baseX, st.baseY, STICK_RADIUS, 0, TAU);
    ctx.fill();
    ctx.stroke();

    // Direction ticks, so the ring reads as a control and not a decoration.
    ctx.strokeStyle = 'rgba(242,239,230,0.28)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      ctx.beginPath();
      ctx.moveTo(st.baseX + Math.cos(a) * (STICK_RADIUS - 12), st.baseY + Math.sin(a) * (STICK_RADIUS - 12));
      ctx.lineTo(st.baseX + Math.cos(a) * (STICK_RADIUS - 3), st.baseY + Math.sin(a) * (STICK_RADIUS - 3));
      ctx.stroke();
    }

    const kx = st.baseX + st.dx;
    const ky = st.baseY + st.dy;
    ctx.fillStyle = live ? 'rgba(232,69,47,0.92)' : 'rgba(242,239,230,0.34)';
    ctx.beginPath();
    ctx.arc(kx, ky, 30, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Gear button.
    const g = t.gear;
    ctx.save();
    ctx.globalAlpha = g.down ? 1 : 0.86;
    ctx.fillStyle = 'rgba(8,9,12,0.66)';
    ctx.beginPath();
    ctx.arc(g.x, g.y, g.r, 0, TAU);
    ctx.fill();
    ctx.lineWidth = g.down ? 5 : 3;
    ctx.strokeStyle = gearColour;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = gearColour;
    ctx.font = '700 26px Impact, "Arial Narrow", sans-serif';
    ctx.fillText(low ? 'LOW' : 'HIGH', g.x, g.y + 4);
    ctx.font = '600 9px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('GEAR', g.x, g.y + 20);
    ctx.restore();

    // Pause.
    const pb = t.pause;
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = 'rgba(8,9,12,0.66)';
    ctx.beginPath();
    ctx.arc(pb.x, pb.y, pb.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(242,239,230,0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(242,239,230,0.85)';
    ctx.fillRect(pb.x - 6, pb.y - 7, 4, 14);
    ctx.fillRect(pb.x + 2, pb.y - 7, 4, 14);
    ctx.restore();
  }

  /** Big confirmation of what you just drove over. */
  drawPickupToast(game) {
    if (game.lastPickup < 0 || game.lastPickupAge > 2.2) return;
    const ctx = this.ctx;
    const def = PICKUP_KINDS[game.lastPickup];
    const t = game.lastPickupAge;
    const fade = t < 1.5 ? 1 : 1 - (t - 1.5) / 0.7;
    const rise = Math.min(1, t / 0.25);

    ctx.save();
    ctx.globalAlpha = clamp(fade, 0, 1);
    ctx.textAlign = 'center';
    ctx.fillStyle = def.colour;
    ctx.font = `700 ${34 + (1 - rise) * 16}px Impact, "Arial Narrow", sans-serif`;
    ctx.fillText(def.name, this.uw / 2, this.uh * 0.26);
    ctx.font = '600 13px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(def.blurb, this.uw / 2, this.uh * 0.26 + 22);
    ctx.restore();
  }

  drawMinimap(game) {
    const ctx = this.ctx;
    const touch = this.touchOn;
    const size = touch ? 124 : 168;
    const pad = touch ? 18 : 22;
    const x = this.uw - size - pad;
    const y = touch ? pad : this.uh - size - pad;
    const range = 2100;
    const s = size / (range * 2);
    const car = game.car;

    ctx.save();
    ctx.fillStyle = 'rgba(8,9,12,0.78)';
    ctx.fillRect(x, y, size, size);
    ctx.beginPath();
    ctx.rect(x, y, size, size);
    ctx.clip();
    ctx.translate(x + size / 2, y + size / 2);
    ctx.scale(s, s);
    ctx.translate(-car.x, -car.y);

    // City blocks.
    const city = game.city;
    ctx.fillStyle = 'rgba(90,95,110,0.55)';
    const c0x = Math.max(0, Math.floor((car.x - range) / CELL));
    const c1x = Math.min(city.cols - 1, Math.floor((car.x + range) / CELL));
    const c0y = Math.max(0, Math.floor((car.y - range) / CELL));
    const c1y = Math.min(city.rows - 1, Math.floor((car.y + range) / CELL));
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const b = city.blocks[cy * city.cols + cx];
        if (b) ctx.fillRect(b.x, b.y, b.w, b.h);
      }
    }

    // Horde, sampled - a dot per third enemy is plenty to read density.
    const list = game.swarm.active;
    ctx.fillStyle = 'rgba(226,80,72,0.9)';
    for (let i = 0; i < list.length; i += 3) {
      const e = list[i];
      ctx.fillRect(e.x - 14, e.y - 14, 28, 28);
    }

    // Crates worth driving to.
    const crates = game.pickups.nearby(car.x, car.y, range, this._pickupQ);
    for (let i = 0; i < crates.length; i++) {
      const p = crates[i];
      if (!p.alive) continue;
      // Outlined so a crate marker never reads as part of the red horde.
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillRect(p.x - 62, p.y - 62, 124, 124);
      ctx.fillStyle = PICKUP_KINDS[p.kind].colour;
      ctx.fillRect(p.x - 44, p.y - 44, 88, 88);
    }

    // You.
    ctx.translate(car.x, car.y);
    ctx.rotate(car.ang);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(90, 0);
    ctx.lineTo(-60, -60);
    ctx.lineTo(-60, 60);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, size, size);
  }

  drawPaused() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(this.dpr * this.uiScale, this.dpr * this.uiScale);
    ctx.fillStyle = 'rgba(6,7,10,0.6)';
    ctx.fillRect(0, 0, this.uw, this.uh);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f2efe6';
    ctx.font = '700 64px Impact, "Arial Narrow", sans-serif';
    ctx.fillText('PAUSED', this.uw / 2, this.uh / 2);
    ctx.font = '600 14px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(this.touchOn ? 'tap to keep driving' : 'press P to keep driving', this.uw / 2, this.uh / 2 + 30);
  }

  drawTitle(game) {
    const ctx = this.ctx;
    const W = this.uw;
    const H = this.uh;
    ctx.fillStyle = 'rgba(6,7,10,0.62)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';

    ctx.fillStyle = '#e8452f';
    ctx.font = `700 ${Math.min(112, W * 0.13)}px Impact, "Arial Narrow", sans-serif`;
    ctx.fillText('SLICK STREETS', W / 2, H * 0.32);

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '600 15px ui-monospace, Menlo, monospace';
    ctx.fillText('the city is full. clear a path.', W / 2, H * 0.32 + 34);

    const lines = this.touchOn ? [
      ['JOYSTICK', 'push where you want to go'],
      ['PULL BACK', 'brake, then reverse'],
      ['GEAR BUTTON', 'change gear'],
      ['LOW gear', 'torque — claws you out of a swarm'],
      ['HIGH gear', 'top speed — but it bogs down in a crowd'],
      ['CRATES', 'drive over them for upgrades'],
    ] : [
      ['W / ↑', 'throttle'],
      ['S / ↓', 'brake · reverse'],
      ['A D / ← →', 'steer'],
      ['SPACE or SHIFT', 'change gear'],
      ['LOW gear', 'torque — claws you out of a swarm'],
      ['HIGH gear', 'top speed — but it bogs down in a crowd'],
      ['P', 'pause    ·    M  mute'],
    ];
    // Panel behind the key list so it stays readable over the city.
    const panelH = lines.length * 25 + 30;
    const panelW = Math.min(620, W * 0.8);
    ctx.fillStyle = 'rgba(8,9,12,0.72)';
    ctx.fillRect(W / 2 - panelW / 2, H * 0.5 - 32, panelW, panelH);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(W / 2 - panelW / 2, H * 0.5 - 32, panelW, panelH);

    ctx.font = '600 14px ui-monospace, Menlo, monospace';
    let y = H * 0.5;
    for (const [k, v] of lines) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffb040';
      ctx.fillText(k, W / 2 - 18, y);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(v, W / 2 + 18, y);
      y += 25;
    }

    if (game.bestScore > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '600 13px ui-monospace, Menlo, monospace';
      ctx.fillText(`BEST RUN  ${game.bestScore}`, W / 2, H * 0.78);
    }

    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(this.frame * 0.06);
    ctx.fillStyle = '#f2efe6';
    ctx.font = '700 26px Impact, "Arial Narrow", sans-serif';
    ctx.fillText(this.touchOn ? 'TAP TO DRIVE' : 'PRESS ENTER TO DRIVE', W / 2, H * 0.86);
    ctx.globalAlpha = 1;
  }

  drawGameOver(game) {
    const ctx = this.ctx;
    const W = this.uw;
    const H = this.uh;
    ctx.fillStyle = 'rgba(30,4,4,0.66)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';

    ctx.fillStyle = '#e8452f';
    ctx.font = `700 ${Math.min(96, W * 0.11)}px Impact, "Arial Narrow", sans-serif`;
    ctx.fillText('YOU STOPPED', W / 2, H * 0.3);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '600 15px ui-monospace, Menlo, monospace';
    ctx.fillText(game.deathCause, W / 2, H * 0.3 + 32);

    const mins = Math.floor(game.time / 60);
    const secs = Math.floor(game.time % 60);
    const rows = [
      ['SCORE', `${game.totalScore}`],
      ['SURVIVED', `${mins}:${secs.toString().padStart(2, '0')}`],
      ['ZOMBIES', `${game.zombieKills}`],
      ['SKELETONS', `${game.skeletonKills}`],
      ['BEST CHAIN', `${game.bestCombo}`],
      ['DISTANCE', `${(game.distance / (PX_PER_METRE * 1000)).toFixed(2)} km`],
      ['BEST', `${Math.max(game.bestScore, game.totalScore)}`],
    ];
    let y = H * 0.46;
    ctx.font = '600 16px ui-monospace, Menlo, monospace';
    if (game.totalScore >= game.bestScore && game.bestScore > 0) {
      ctx.fillStyle = '#ffb040';
      ctx.font = '700 20px Impact, "Arial Narrow", sans-serif';
      ctx.fillText('NEW BEST', W / 2, y - 26);
      ctx.font = '600 16px ui-monospace, Menlo, monospace';
    }
    for (const [k, v] of rows) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(k, W / 2 - 16, y);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#f2efe6';
      ctx.fillText(v, W / 2 + 16, y);
      y += 27;
    }

    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(this.frame * 0.06);
    ctx.fillStyle = '#f2efe6';
    ctx.font = '700 24px Impact, "Arial Narrow", sans-serif';
    ctx.fillText(this.touchOn ? 'TAP TO DRIVE AGAIN' : 'PRESS ENTER TO DRIVE AGAIN', W / 2, H * 0.88);
    ctx.globalAlpha = 1;
  }
}
