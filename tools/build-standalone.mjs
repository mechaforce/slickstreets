// Bundles the ES modules into a single self-contained HTML file, so the game
// can be opened straight from disk (or dropped anywhere that serves one page)
// without a server or a module loader.
//
//   node tools/build-standalone.mjs
//
// The modules stay the source of truth; this only concatenates them in
// dependency order, strips the import/export keywords, and wraps the result.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Dependency order: every module appears after everything it uses.
const ORDER = [
  'util.js',
  'spatialhash.js',
  'city.js',
  'pickups.js',
  'touch.js',
  'car.js',
  'enemies.js',
  'gore.js',
  'game.js',
  'sprites.js',
  'input.js',
  'audio.js',
  'render.js',
  'main.js',
];

const IMPORT = /^\s*import\s[\s\S]*?from\s*'[^']*';\s*$/gm;
const EXPORT = /^export\s+(?=const|let|var|function|class)/gm;

function strip(src, name) {
  const out = src.replace(IMPORT, '').replace(EXPORT, '');
  if (/^\s*(import|export)\s/m.test(out)) {
    throw new Error(`${name}: unhandled import/export survived the strip`);
  }
  return out.trim();
}

/**
 * Guard against two modules declaring the same top-level name, and against a
 * module colliding with anything the HTML wrapper below declares.
 */
const WRAPPER_NAMES = ['bootFocus'];

function checkCollisions(modules) {
  const seen = new Map();
  for (const n of WRAPPER_NAMES) seen.set(n, '<wrapper>');
  const decl = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const { name, code } of modules) {
    for (const m of code.matchAll(decl)) {
      const prev = seen.get(m[1]);
      if (prev !== undefined && prev !== name) {
        throw new Error(`name collision: "${m[1]}" declared in both ${prev} and ${name}`);
      }
      seen.set(m[1], name);
    }
  }
  return seen.size;
}

// A module missing from ORDER would be silently dropped from the bundle and
// only fail at runtime, so refuse to build until it is placed deliberately.
const present = (await readdir(join(root, 'js'))).filter((f) => f.endsWith('.js')).sort();
const missing = present.filter((f) => !ORDER.includes(f));
const stale = ORDER.filter((f) => !present.includes(f));
if (missing.length > 0) {
  throw new Error(`js/${missing.join(', js/')} not listed in ORDER - add it in dependency order`);
}
if (stale.length > 0) {
  throw new Error(`ORDER lists files that no longer exist: ${stale.join(', ')}`);
}

const modules = [];
for (const name of ORDER) {
  const src = await readFile(join(root, 'js', name), 'utf8');
  modules.push({ name, code: strip(src, name) });
}
const names = checkCollisions(modules);

const css = await readFile(join(root, 'css', 'style.css'), 'utf8');

const body = modules
  .map((m) => `// ${'='.repeat(66)}\n// js/${m.name}\n// ${'='.repeat(66)}\n\n${m.code}`)
  .join('\n\n');

const html = `<title>Slick Streets</title>
<style>
${css.trim()}

/* Standalone build: the page is nothing but the game. */
#hint {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  padding: 7px 14px;
  font: 600 12px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  letter-spacing: 0.08em;
  color: rgba(242, 239, 230, 0.72);
  background: rgba(8, 9, 12, 0.82);
  border: 1px solid rgba(242, 239, 230, 0.16);
  pointer-events: none;
  transition: opacity 0.4s ease;
}
#hint.gone { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  #hint { transition: none; }
}
</style>

<canvas id="game" tabindex="0"></canvas>
<div id="hint">CLICK THE STREET, THEN PRESS ENTER</div>

<script>
(function () {
  'use strict';

${body}

  // Keyboard input needs focus, which an embedded frame does not get for free.
  // Scoped separately so these names cannot collide with the modules above.
  function bootFocus() {
    var hintEl = document.getElementById('hint');
    var canvasEl = document.getElementById('game');
    var dismiss = function () { if (hintEl) hintEl.classList.add('gone'); };
    // A phone needs different words, and no instruction to click.
    try {
      if (hintEl && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
        hintEl.textContent = 'TAP TO DRIVE';
      }
    } catch (err) { /* leave the default wording */ }
    canvasEl.addEventListener('touchstart', dismiss, { passive: true });
    canvasEl.addEventListener('pointerdown', function () {
      canvasEl.focus();
      dismiss();
    });
    window.addEventListener('keydown', dismiss, { once: true });
    window.addEventListener('load', function () { canvasEl.focus(); });
    canvasEl.focus();
  }
  bootFocus();
})();
</script>
`;

await mkdir(join(root, 'dist'), { recursive: true });
const outPath = join(root, 'dist', 'slick-streets.html');
await writeFile(outPath, html, 'utf8');
console.log(`built ${outPath}`);
console.log(`  ${modules.length} modules, ${names} top-level names, ${(html.length / 1024).toFixed(0)} KB`);
