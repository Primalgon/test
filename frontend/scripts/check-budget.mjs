#!/usr/bin/env node
/**
 * Performance and hygiene gate for a generated site. Runs after `vite build`,
 * before the site is handed to step 6.
 *
 *   npm run build && npm run budget
 *
 * Three things are checked, in descending order of how often they break:
 *
 *  1. three.js must NOT be in the entry chunk. The whole 3D architecture rests
 *     on three being lazily imported behind a capability gate. One static
 *     `import { Mesh } from 'three'` in a shared module silently collapses that
 *     — the build still succeeds, the site still works, and every visitor now
 *     downloads ~600 kB whether or not their device can use it. Nothing else in
 *     the pipeline catches this, which is why it is check number one.
 *  2. Chunk and total sizes stay inside budget.
 *  3. No secret, placeholder token, or lorem text survived into the bundle.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';

const DIST = 'dist';
const ASSETS = join(DIST, 'assets');

// Budgets are gzip bytes — that is what actually crosses the wire.
const BUDGET = {
  entryJs: 190 * 1024,      // app shell: React + router + our code
  threeChunk: 320 * 1024,   // three + fiber + drei, gzipped, loaded on demand only
  anyOtherChunk: 120 * 1024,
  totalCss: 40 * 1024,
  initialTotal: 240 * 1024, // everything the browser must have before first paint
};

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

if (!existsSync(DIST)) {
  console.error('No dist/ directory. Run `npm run build` first.');
  process.exit(1);
}

const failures = [];
const warnings = [];
const notes = [];

/* ------------------------------------------------------------------ *
 * 1. Locate chunks
 * ------------------------------------------------------------------ */

const files = await readdir(ASSETS);
const chunks = [];

for (const name of files) {
  const path = join(ASSETS, name);
  const raw = await readFile(path);
  chunks.push({
    name,
    path,
    ext: extname(name),
    bytes: (await stat(path)).size,
    gzip: gzipSync(raw).length,
    text: ['.js', '.css', '.html'].includes(extname(name)) ? raw.toString('utf8') : '',
  });
}

const js = chunks.filter((c) => c.ext === '.js');
const css = chunks.filter((c) => c.ext === '.css');

// Vite names the entry `index-<hash>.js`; the html tells us definitively.
const html = await readFile(join(DIST, 'index.html'), 'utf8');
const entryMatch = html.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
const entry = js.find((c) => c.name === entryMatch?.[1]) ?? js.find((c) => c.name.startsWith('index'));

if (!entry) {
  failures.push('Could not identify the entry chunk from index.html — the build output looks unexpected.');
}

/* ------------------------------------------------------------------ *
 * 2. The lazy-three boundary
 * ------------------------------------------------------------------ */

// Signatures that only appear in three's own source, not in code that merely
// references it by name. Matching on the string "three" alone gives false
// positives from import maps and comments.
const THREE_SIGNATURES = [
  'WebGLRenderer',
  'BufferGeometry',
  'PerspectiveCamera',
  'ShaderChunk',
];

const threeChunks = js.filter((c) => THREE_SIGNATURES.filter((s) => c.text.includes(s)).length >= 2);

if (entry && threeChunks.some((c) => c.name === entry.name)) {
  failures.push(
    `three.js is bundled into the entry chunk (${entry.name}). Every visitor now downloads the ` +
    `3D engine before first paint, including devices that will never render it. Find the static ` +
    `import — it is usually a type-only import written without \`import type\`, or a helper that ` +
    `pulled in a drei component at module scope.`,
  );
}

if (threeChunks.length === 0) {
  notes.push('No three.js chunk found. Fine if this brief set three_d.required = false; a bug otherwise.');
} else if (threeChunks.length > 2) {
  warnings.push(
    `three appears in ${threeChunks.length} separate chunks (${threeChunks.map((c) => c.name).join(', ')}). ` +
    `Duplicated engine code means it is downloaded more than once. Check manualChunks in vite.config.ts.`,
  );
}

for (const c of threeChunks) {
  if (entry && c.name === entry.name) continue;
  if (c.gzip > BUDGET.threeChunk) {
    warnings.push(`3D chunk ${c.name} is ${kb(c.gzip)} gzipped, over the ${kb(BUDGET.threeChunk)} budget. ` +
      `Usually a drei import pulling in more than intended — import from the specific path, not the barrel.`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. Size budgets
 * ------------------------------------------------------------------ */

if (entry && entry.gzip > BUDGET.entryJs) {
  failures.push(`Entry chunk ${entry.name} is ${kb(entry.gzip)} gzipped, over the ${kb(BUDGET.entryJs)} budget.`);
}

const totalCss = css.reduce((n, c) => n + c.gzip, 0);
if (totalCss > BUDGET.totalCss) {
  warnings.push(`CSS totals ${kb(totalCss)} gzipped, over ${kb(BUDGET.totalCss)}. All six design directions ` +
    `ship in directions.css; only the selected one should. Strip the unused blocks at generation time.`);
}

for (const c of js) {
  if (c === entry) continue;
  if (threeChunks.includes(c)) continue;
  if (c.gzip > BUDGET.anyOtherChunk) {
    warnings.push(`Chunk ${c.name} is ${kb(c.gzip)} gzipped, over the ${kb(BUDGET.anyOtherChunk)} per-chunk budget.`);
  }
}

const initial = (entry?.gzip ?? 0) + totalCss;
if (initial > BUDGET.initialTotal) {
  failures.push(`Initial payload is ${kb(initial)} gzipped, over the ${kb(BUDGET.initialTotal)} budget.`);
}

/* ------------------------------------------------------------------ *
 * 4. Leaks and leftovers
 * ------------------------------------------------------------------ */

const SECRET_PATTERNS = [
  [/sk_live_[A-Za-z0-9]{10,}/, 'a live Stripe secret key'],
  [/sk_test_[A-Za-z0-9]{10,}/, 'a test Stripe secret key'],
  [/whsec_[A-Za-z0-9]{10,}/, 'a Stripe webhook signing secret'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'what looks like a JWT (Supabase service key?)'],
  [/\bTURSO_AUTH_TOKEN\b/, 'a Turso auth token reference'],
  [/SUPABASE_SERVICE_ROLE/, 'a Supabase service-role key reference'],
  [/ZEPTOMAIL/, 'a ZeptoMail credential reference'],
];

// Placeholder tokens the generator is supposed to have rewritten.
const PLACEHOLDERS = [
  'SITE_NAME', 'SITE_DOMAIN', 'SITE_TITLE', 'SITE_DESCRIPTION', 'CONTACT_EMAIL',
  'BUSINESS_ONE_LINER', 'BUSINESS_AUDIENCE', 'PRIMARY_CTA_LABEL',
];

const LOREM = /\b(lorem ipsum|dolor sit amet|your company here|coming soon)\b/i;

const textFiles = [...chunks.filter((c) => c.text), { name: 'index.html', text: html }];

for (const f of textFiles) {
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(f.text)) {
      failures.push(`${f.name} contains ${label}. This is a client-side bundle — treat it as public and rotate the key now.`);
    }
  }
  for (const token of PLACEHOLDERS) {
    if (f.text.includes(token)) {
      failures.push(`${f.name} still contains the placeholder token "${token}" — generation did not complete.`);
    }
  }
  if (LOREM.test(f.text)) {
    failures.push(`${f.name} contains placeholder copy. Every string must trace back to the brief.`);
  }
  if (/\bTODO\b|\bFIXME\b/.test(f.text) && f.ext === '.js') {
    warnings.push(`${f.name} contains a TODO or FIXME comment.`);
  }
}

/* ------------------------------------------------------------------ *
 * 4b. Client-side exposure
 *
 * What a visitor can read out of the bundle with devtools open. None of this is
 * about *blocking* devtools — that is not possible and never was. It is about
 * there being nothing worth finding when they look.
 * ------------------------------------------------------------------ */

const maps = files.filter((f) => f.endsWith('.map'));
if (maps.length) {
  failures.push(
    `Source maps in the build output (${maps.join(', ')}). A source map is the original code — ` +
    `component names, comments, folder structure, and every string minification was supposed to bury. ` +
    `Devtools loads it automatically, so the minified bundle is cosmetic. Set build.sourcemap to false, ` +
    `or 'hidden' if you upload them to an error tracker.`,
  );
}

for (const f of js) {
  if (/\/\/# sourceMappingURL=/.test(f.text)) {
    failures.push(`${f.name} references a source map. Even without the .map file present, this points at your original code.`);
  }
  // Absolute build paths expose the CI user, directory layout, and often the
  // client's name. Free reconnaissance for zero attacker effort.
  if (/\/home\/runner\/|\/Users\/[a-z]+\/|C:\\\\Users/.test(f.text)) {
    warnings.push(`${f.name} contains absolute filesystem paths from the build machine.`);
  }
  // console.log in production leaks internal state and object shapes straight
  // into the visitor's console. terser drop_console should have removed these.
  const consoleCalls = (f.text.match(/console\.(log|debug|info|table|trace)\(/g) || []).length;
  if (consoleCalls > 0) {
    warnings.push(`${f.name} has ${consoleCalls} console call(s) left in production. Check terserOptions.compress.drop_console.`);
  }
  // Internal API surface enumerated in the bundle.
  if (/\/api\/(admin|_internal|debug|_n8n)\b/.test(f.text)) {
    warnings.push(`${f.name} references internal API paths. A public page should not name the admin surface.`);
  }
}

/* ------------------------------------------------------------------ *
 * 5. Asset manifest state
 * ------------------------------------------------------------------ */

let manifestState = null;
try {
  const manifest = JSON.parse(await readFile('src/data/assets.manifest.json', 'utf8'));
  const entries = Object.values(manifest.assets ?? {});
  const notReady = entries.filter((a) => a.status !== 'ready' && a.source !== 'client_supplied');
  const noPoster = entries.filter((a) => !a.poster);

  manifestState = { total: entries.length, ready: entries.length - notReady.length };

  if (notReady.length) {
    warnings.push(
      `${notReady.length} of ${entries.length} 3D assets are still placeholders ` +
      `(${notReady.map((a) => a.key).join(', ')}). Expected before step 4; a blocker after it.`,
    );
  }
  if (noPoster.length) {
    failures.push(
      `Assets without a poster image: ${noPoster.map((a) => a.key).join(', ')}. The poster is what a ` +
      `visitor with no WebGL sees — without it that section is an empty box.`,
    );
  }
} catch {
  notes.push('No asset manifest found at src/data/assets.manifest.json.');
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

console.log('\nBundle');
console.log('------');
if (entry) console.log(`  entry         ${entry.name.padEnd(34)} ${kb(entry.gzip).padStart(9)} gz  (${kb(entry.bytes)} raw)`);
for (const c of js.filter((c) => c !== entry).sort((a, b) => b.gzip - a.gzip)) {
  const tag = threeChunks.includes(c) ? ' [3D, lazy]' : '';
  console.log(`  chunk         ${c.name.padEnd(34)} ${kb(c.gzip).padStart(9)} gz${tag}`);
}
for (const c of css) console.log(`  css           ${c.name.padEnd(34)} ${kb(c.gzip).padStart(9)} gz`);
console.log(`  initial load  ${''.padEnd(34)} ${kb(initial).padStart(9)} gz  (budget ${kb(BUDGET.initialTotal)})`);

if (notes.length) {
  console.log('\nNotes');
  console.log('-----');
  for (const n of notes) console.log(`  · ${n}`);
}
if (warnings.length) {
  console.log('\nWarnings');
  console.log('--------');
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (failures.length) {
  console.log('\nFailures');
  console.log('--------');
  for (const f of failures) console.log(`  ✗ ${f}`);
}

const result = {
  passed: failures.length === 0,
  initial_gzip: initial,
  entry_gzip: entry?.gzip ?? null,
  three_lazy: entry ? !threeChunks.some((c) => c.name === entry.name) : null,
  chunks: js.length + css.length,
  manifest: manifestState,
  failures,
  warnings,
};

console.log(`\n${result.passed ? 'PASS' : 'FAIL'} — ${failures.length} failure(s), ${warnings.length} warning(s)\n`);
console.log('::result::' + JSON.stringify(result));

process.exit(result.passed ? 0 : 1);
