// Procedural city: a grid of blocks separated by roads. Every solid is an
// axis-aligned box indexed by block cell, which keeps collision queries O(1).

import { mulberry32, rr, ri, pick, clamp } from './util.js';

export const CELL = 460;   // block pitch, road centre to road centre
export const ROAD = 150;   // drivable width between block interiors

const WALL_COLORS = ['#4a4b56', '#565361', '#3f4450', '#5c5145', '#4d4a41', '#63606d'];
const ROOF_COLORS = ['#6e6f7d', '#7b7787', '#5f6675', '#857462', '#6f6b5f', '#8a8697'];

/** One solid obstacle. `top` is used by the renderer for fake extrusion. */
function solid(x, y, w, h, kind, wall, roof, top) {
  return { x, y, w, h, kind, wall, roof, top };
}

/**
 * Split a rect into 1..n sub-rects, recursing on the longer axis.
 * Produces believable rows of terraced buildings rather than a uniform grid.
 */
function subdivide(rng, x, y, w, h, depth, out) {
  const minSide = 78;
  if (depth <= 0 || (w < minSide * 2 && h < minSide * 2) || rng() < 0.18) {
    out.push([x, y, w, h]);
    return;
  }
  const splitX = w > h ? rng() < 0.85 : rng() < 0.15;
  if (splitX && w >= minSide * 2) {
    const t = rr(rng, 0.34, 0.66);
    const a = Math.round(w * t);
    subdivide(rng, x, y, a, h, depth - 1, out);
    subdivide(rng, x + a, y, w - a, h, depth - 1, out);
  } else if (!splitX && h >= minSide * 2) {
    const t = rr(rng, 0.34, 0.66);
    const a = Math.round(h * t);
    subdivide(rng, x, y, w, a, depth - 1, out);
    subdivide(rng, x, y + a, w, h - a, depth - 1, out);
  } else {
    out.push([x, y, w, h]);
  }
}

export function generateCity(seed = 1, cols = 40, rows = 40) {
  const rng = mulberry32(seed >>> 0);
  const city = {
    seed,
    cols,
    rows,
    cell: CELL,
    road: ROAD,
    width: cols * CELL,
    height: rows * CELL,
    blocks: [],
    solids: [],
    grid: new Map(),
  };

  const put = (cx, cy, s) => {
    const k = cx * 8192 + cy;
    let list = city.grid.get(k);
    if (list === undefined) city.grid.set(k, (list = []));
    list.push(s);
    city.solids.push(s);
  };

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const bx = cx * CELL + ROAD * 0.5;
      const by = cy * CELL + ROAD * 0.5;
      const bw = CELL - ROAD;
      const bh = CELL - ROAD;

      const roll = rng();
      const type = roll < 0.09 ? 'park' : roll < 0.18 ? 'lot' : 'buildings';
      const block = { cx, cy, x: bx, y: by, w: bw, h: bh, type, props: [] };
      city.blocks.push(block);

      if (type === 'buildings') {
        const pad = 16;
        const parts = [];
        subdivide(rng, bx + pad, by + pad, bw - pad * 2, bh - pad * 2, 2, parts);
        for (const [px, py, pw, ph] of parts) {
          const gap = rr(rng, 3, 11);
          const w = pw - gap * 2;
          const h = ph - gap * 2;
          if (w < 42 || h < 42) continue;
          const idx = ri(rng, 0, WALL_COLORS.length - 1);
          put(cx, cy, solid(px + gap, py + gap, w, h, 'building',
            WALL_COLORS[idx], ROOF_COLORS[idx], rr(rng, 34, 96)));
        }
      } else if (type === 'park') {
        const n = ri(rng, 4, 9);
        for (let i = 0; i < n; i++) {
          const r = rr(rng, 16, 26);
          const x = rr(rng, bx + 30, bx + bw - 30 - r * 2);
          const y = rr(rng, by + 30, by + bh - 30 - r * 2);
          put(cx, cy, solid(x, y, r * 2, r * 2, 'tree', '#2f4a2c', '#3f6b39', rr(rng, 40, 62)));
        }
      } else {
        const n = ri(rng, 2, 5);
        for (let i = 0; i < n; i++) {
          const horiz = rng() < 0.5;
          const w = horiz ? 56 : 28;
          const h = horiz ? 28 : 56;
          const x = rr(rng, bx + 24, bx + bw - 24 - w);
          const y = rr(rng, by + 24, by + bh - 24 - h);
          put(cx, cy, solid(x, y, w, h, 'wreck',
            pick(rng, ['#5b3a3a', '#3a4a5b', '#4a4a3a', '#52525c']), '#2a2a30', 16));
        }
      }
    }
  }

  // Boundary walls so the player cannot leave the map.
  const T = 220;
  const W = city.width;
  const H = city.height;
  const edge = (x, y, w, h) => {
    const s = solid(x, y, w, h, 'wall', '#33343d', '#43444f', 130);
    city.solids.push(s);
    city.edges = city.edges || [];
    city.edges.push(s);
  };
  edge(-T, -T, W + T * 2, T);
  edge(-T, H, W + T * 2, T);
  edge(-T, 0, T, H);
  edge(W, 0, T, H);

  return city;
}

/** Solids whose block cell overlaps the circle, plus the boundary walls. */
export function solidsNear(city, x, y, r, out) {
  out.length = 0;
  const c = city.cell;
  const x0 = Math.floor((x - r) / c);
  const x1 = Math.floor((x + r) / c);
  const y0 = Math.floor((y - r) / c);
  const y1 = Math.floor((y + r) / c);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const list = city.grid.get(cx * 8192 + cy);
      if (list === undefined) continue;
      for (let i = 0; i < list.length; i++) out.push(list[i]);
    }
  }
  if (city.edges && (x - r < 0 || y - r < 0 || x + r > city.width || y + r > city.height)) {
    for (const e of city.edges) out.push(e);
  }
  return out;
}

const _scratch = [];

/** True if a circle overlaps any solid - used to reject spawn points. */
export function isBlocked(city, x, y, r) {
  const list = solidsNear(city, x, y, r, _scratch);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const nx = clamp(x, s.x, s.x + s.w);
    const ny = clamp(y, s.y, s.y + s.h);
    const dx = x - nx;
    const dy = y - ny;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

/**
 * Push a circle out of every overlapping solid.
 * Returns the accumulated push (nx, ny) and the deepest penetration.
 */
export function resolveCircle(city, p, r, hit) {
  const list = solidsNear(city, p.x, p.y, r, _scratch);
  hit.nx = 0;
  hit.ny = 0;
  hit.depth = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const nx = clamp(p.x, s.x, s.x + s.w);
    const ny = clamp(p.y, s.y, s.y + s.h);
    let dx = p.x - nx;
    let dy = p.y - ny;
    let d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;

    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      const push = r - d;
      dx /= d;
      dy /= d;
      p.x += dx * push;
      p.y += dy * push;
      hit.nx += dx * push;
      hit.ny += dy * push;
      if (push > hit.depth) hit.depth = push;
    } else {
      // Centre is inside the box: eject along the shallowest axis.
      const cx = s.x + s.w * 0.5;
      const cy = s.y + s.h * 0.5;
      const ox = s.w * 0.5 + r - Math.abs(p.x - cx);
      const oy = s.h * 0.5 + r - Math.abs(p.y - cy);
      if (ox < oy) {
        const dir = p.x < cx ? -1 : 1;
        p.x += ox * dir;
        hit.nx += ox * dir;
        if (ox > hit.depth) hit.depth = ox;
      } else {
        const dir = p.y < cy ? -1 : 1;
        p.y += oy * dir;
        hit.ny += oy * dir;
        if (oy > hit.depth) hit.depth = oy;
      }
    }
  }
  return hit;
}

/** A road-centre point near (x, y): handy for spawning things on tarmac. */
export function nearestRoadPoint(city, x, y) {
  const c = city.cell;
  const cx = Math.round(x / c);
  const cy = Math.round(y / c);
  const onVertical = Math.abs(x - cx * c) < Math.abs(y - cy * c);
  return onVertical ? { x: cx * c, y } : { x, y: cy * c };
}
