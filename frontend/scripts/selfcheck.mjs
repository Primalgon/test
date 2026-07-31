#!/usr/bin/env node
/**
 * Self-review. Run after generation, before deploy.
 *
 *   npm run selfcheck
 *
 * Checks everything that can be checked mechanically, then writes a single
 * self-contained HTML report — no external CSS, no fonts, no images — that opens
 * by double-clicking. That report is the one file you actually want: it tells
 * you whether the site is finished. The site itself cannot be one file, for
 * reasons the report explains in its own footer.
 *
 * Exit code is 1 if any BLOCKER failed, so CI and the generation run both stop
 * on it rather than reporting green and moving on.
 *
 * ## Why a script and not a list in the prompt
 *
 * A checklist a model reads is a checklist a model marks complete. The failures
 * that have actually happened here — a missing login page, a price typed into
 * markup, a stray .html file — were all invisible to a model reviewing its own
 * work, because from the inside the output looked finished. Only a process that
 * reads the files independently catches them.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd().endsWith('frontend') ? join(process.cwd(), '..') : process.cwd();
const FE = join(ROOT, 'frontend');
const BE = join(ROOT, 'backend');

const results = [];
const add = (severity, area, name, passed, detail = '') =>
  results.push({ severity, area, name, passed, detail });

const BLOCKER = 'blocker';
const WARN = 'warn';

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (e !== 'node_modules' && e !== 'dist') walk(full, out); }
    else out.push(full);
  }
  return out;
};
const sh = (cmd) => { try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim(); } catch { return null; } };

/* ══════════════════════════════════════════════════════════════════════════
   1. STRUCTURE — did the run edit the template, or replace it?
   ══════════════════════════════════════════════════════════════════════════ */

const ALLOWED = [
  'frontend/src/site.config.ts', 'frontend/index.html',
  'frontend/src/pages/', 'frontend/src/sections/',
  'frontend/src/data/assets.manifest.json', 'frontend/src/styles/directions.css',
  'backend/wrangler.toml', 'brief.json', 'results.json',
];

const changed = (sh('git diff --name-only HEAD') || '').split('\n').filter(Boolean);
const untracked = (sh('git ls-files --others --exclude-standard') || '').split('\n').filter(Boolean);
const touched = [...new Set([...changed, ...untracked])];

const outsideScope = touched.filter((f) => !ALLOWED.some((a) => f.startsWith(a)));
add(BLOCKER, 'Structure', 'Only permitted files were modified', outsideScope.length === 0,
  outsideScope.length ? `Outside scope: ${outsideScope.join(', ')}` : `${touched.length} file(s), all in scope`);

// The specific failure mode: abandoning the template and hand-writing a static
// site. It always shows up as loose .html files at the repo root.
const strayHtml = touched.filter((f) => f.endsWith('.html') && f !== 'frontend/index.html');
add(BLOCKER, 'Structure', 'No standalone .html files created', strayHtml.length === 0,
  strayHtml.length
    ? `Found: ${strayHtml.join(', ')}. This means the run built a static site instead of editing the template — no backend, no auth, no asset manifest.`
    : 'Only frontend/index.html, as intended');

/* ══════════════════════════════════════════════════════════════════════════
   2. SECURITY BOUNDARY
   ══════════════════════════════════════════════════════════════════════════ */

const protectedPaths = [
  'backend/src/middleware', 'backend/src/lib', 'backend/src/db',
  'frontend/src/three', 'contracts',
];
const boundaryDiff = sh(`git diff --stat ${protectedPaths.join(' ')}`);
add(BLOCKER, 'Security', 'Protected files unmodified', !boundaryDiff,
  boundaryDiff ? `Modified:\n${boundaryDiff}` : 'auth, crypto, CSP, SSRF guard, 3D gate all intact');

for (const [file, needle, why] of [
  ['backend/src/middleware/security.ts', 'require-trusted-types-for', 'Trusted Types directive'],
  ['backend/src/middleware/auth.ts', '__Host-', '__Host- cookie prefix'],
  ['backend/src/lib/ssrf.ts', "redirect: 'manual'", 'SSRF redirect re-validation'],
]) {
  const src = read(join(ROOT, file));
  add(BLOCKER, 'Security', `${why} present`, !!src && src.includes(needle),
    src ? '' : `${file} is missing entirely`);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. INDUSTRY PRESET COMPLIANCE — the check that catches a missing login
   ══════════════════════════════════════════════════════════════════════════ */

const brief = (() => { try { return JSON.parse(read(join(ROOT, 'brief.json'))); } catch { return null; } })();
const presetSrc = read(join(ROOT, 'contracts/industry-presets.ts')) ?? '';
const industry = brief?.business?.industry;

let preset = null;
if (industry) {
  // Parse the preset entry out of the TS source rather than importing it, so
  // this script has no build step and no dependencies.
  const block = presetSrc.split(/\n  \{\n/).find((b) => b.includes(`id: "${industry}"`));
  if (block) {
    preset = {
      commerce: /commerce: "([^"]+)"/.exec(block)?.[1],
      auth: /auth: "([^"]+)"/.exec(block)?.[1],
      sections: JSON.parse(/sections: (\[[^\]]*\])/.exec(block)?.[1] ?? '[]'),
      subjects: JSON.parse(/subjects: (\[[^\]]*\])/.exec(block)?.[1] ?? '[]'),
    };
  }
}

add(BLOCKER, 'Preset', 'Brief names a known industry preset', !!preset,
  preset ? `${industry} — commerce: ${preset.commerce}, auth: ${preset.auth}`
         : `business.industry is "${industry ?? 'unset'}", not found in industry-presets.ts`);

const pageFiles = walk(join(FE, 'src/pages')).concat(walk(join(FE, 'src/sections')));
const pageSrc = pageFiles.map((f) => read(f) ?? '').join('\n');

const SECTION_COMPONENT = {
  hero3d: 'Hero3D', feature_grid: 'FeatureGrid', product_showcase_3d: 'ProductShowcase3D',
  process_timeline: 'ProcessTimeline', proof: 'Proof', pricing: 'Pricing', faq: 'Faq',
  team: 'Team', gallery: 'Gallery', contact_form: 'ContactForm', cta_band: 'CtaBand',
  logo_wall: 'LogoWall', stat_band: 'StatBand', editorial_long: 'EditorialLong',
  location_hours: 'LocationHours',
};

if (preset) {
  const missing = preset.sections.filter((s) => {
    const comp = SECTION_COMPONENT[s];
    return comp && !new RegExp(`<${comp}\\b`).test(pageSrc);
  });
  add(BLOCKER, 'Preset', 'Every section the preset requires is rendered', missing.length === 0,
    missing.length ? `Missing: ${missing.join(', ')}` : `All ${preset.sections.length} present`);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. AUTH — the failure that produced a brochure with no login
   ══════════════════════════════════════════════════════════════════════════ */

const needsAuth = preset && (preset.auth === 'required' ||
  preset.commerce === 'subscription' || preset.commerce === 'booking');

if (needsAuth) {
  const pageNames = walk(join(FE, 'src/pages')).map((f) => relative(FE, f).toLowerCase());
  const hasLogin  = pageNames.some((n) => /login|signin/.test(n));
  const hasSignup = pageNames.some((n) => /signup|register|join/.test(n));
  const hasAccount = pageNames.some((n) => /account|dashboard|profile/.test(n));

  add(BLOCKER, 'Auth', 'Login page exists', hasLogin,
    hasLogin ? '' : `Preset requires auth (${preset.auth}/${preset.commerce}) but no login page was built. The account IS the product for this vertical — this site is non-functional, not simpler.`);
  add(BLOCKER, 'Auth', 'Signup page exists', hasSignup,
    hasSignup ? '' : 'No signup page. Visitors cannot become customers.');
  add(BLOCKER, 'Auth', 'Account page exists', hasAccount,
    hasAccount ? '' : 'No account page. Users cannot see their own orders, bookings, or subscription.');

  add(BLOCKER, 'Auth', 'Frontend calls the auth API', /\/api\/auth\//.test(pageSrc),
    /\/api\/auth\//.test(pageSrc) ? '' : 'No /api/auth/ calls found. The backend auth routes exist and are secured — wire to them, do not reimplement.');

  if (preset.commerce === 'subscription') {
    add(BLOCKER, 'Auth', 'Billing portal linked', /billing|portal|subscription/i.test(pageSrc),
      'Subscription sites need a route to Stripe\'s billing portal so users can cancel without emailing you.');
  }
} else if (preset) {
  add(WARN, 'Auth', 'Auth not required by preset', true, `${preset.auth}/${preset.commerce} — guest flow is acceptable`);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. ASSET MANIFEST — whether the Higgsfield step can run at all
   ══════════════════════════════════════════════════════════════════════════ */

const manifestPath = join(FE, 'src/data/assets.manifest.json');
const manifest = (() => { try { return JSON.parse(read(manifestPath)); } catch { return null; } })();

add(BLOCKER, 'Assets', 'Manifest is valid JSON', !!manifest, manifest ? '' : 'Cannot parse assets.manifest.json');

if (manifest && preset) {
  const keys = (manifest.assets ?? []).map((a) => a.key);
  const briefKeys = (brief?.three_d?.subjects ?? []).map((s) => s.key);
  add(BLOCKER, 'Assets', 'One manifest entry per brief subject',
    briefKeys.length > 0 && briefKeys.every((k) => keys.includes(k)),
    `brief: [${briefKeys}] manifest: [${keys}]`);

  const noAlt = (manifest.assets ?? []).filter((a) => !a.alt);
  add(BLOCKER, 'Assets', 'Every asset has alt text', noAlt.length === 0,
    noAlt.length ? `Missing alt: ${noAlt.map((a) => a.key).join(', ')}` : '');

  const fabricated = (manifest.assets ?? []).filter((a) => a.url && a.source === 'primitive');
  add(BLOCKER, 'Assets', 'No fabricated model URLs', fabricated.length === 0,
    fabricated.length ? `Invented URLs: ${fabricated.map((a) => a.key).join(', ')}. Real GLBs come from Higgsfield.` : '');

  const noPoster = (manifest.assets ?? []).filter((a) => a.status === 'ready' && !a.poster);
  add(WARN, 'Assets', 'Ready assets have posters', noPoster.length === 0,
    noPoster.length ? `${noPoster.map((a) => a.key).join(', ')} — visitors without WebGL see an empty box`
                    : 'Expected to fail until step 4 (Higgsfield) has run');
}

add(BLOCKER, 'Assets', 'Sections use getAsset(), never a hardcoded URL',
  !/from ['"]three['"]/.test(pageSrc) && !/\.glb['"]/.test(pageSrc),
  'A direct three.js import or .glb literal in a section breaks the Higgsfield swap');

/* ══════════════════════════════════════════════════════════════════════════
   6. COMMERCE — prices must not be in the bundle
   ══════════════════════════════════════════════════════════════════════════ */

const priceLiteral = /(?:price|amount|cost)\s*[:=]\s*['"]?[$£€]?\d/i;
const offenders = pageFiles.filter((f) => priceLiteral.test(read(f) ?? ''));
add(BLOCKER, 'Commerce', 'No hardcoded prices', offenders.length === 0,
  offenders.length ? `${offenders.map((f) => relative(ROOT, f)).join(', ')} — a price in the bundle is a price the visitor edits in devtools before checkout`
                   : 'Prices resolve from the products table');

if (preset && preset.commerce !== 'none') {
  add(BLOCKER, 'Commerce', 'Uses the commerce hook', /useProducts|startCheckout/.test(pageSrc),
    'Import from lib/commerce.ts rather than fetching products ad hoc');
}

/* ══════════════════════════════════════════════════════════════════════════
   7. EXPOSURE & CSP
   ══════════════════════════════════════════════════════════════════════════ */

const indexHtml = read(join(FE, 'index.html')) ?? '';
const externalOrigin = /(fonts\.googleapis|fonts\.gstatic|cdnjs|unpkg|jsdelivr)/;
add(BLOCKER, 'CSP', 'No external origins', !externalOrigin.test(indexHtml + pageSrc),
  externalOrigin.test(indexHtml + pageSrc)
    ? 'Google Fonts / CDN reference found. The nonce CSP blocks these — the page renders unstyled and the 3D never loads.'
    : 'Fonts self-hosted');

const placeholders = /SITE_NAME|CONTACT_EMAIL|PRIMARY_CTA_LABEL|lorem ipsum|Coming soon|TODO/i;
add(BLOCKER, 'Content', 'No placeholder tokens', !placeholders.test(indexHtml + pageSrc),
  'A surviving placeholder means a brief field was never applied');

const secretish = /(sk_live_|sk_test_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJhbGciOi)/;
add(BLOCKER, 'Exposure', 'No secrets in frontend source', !secretish.test(pageSrc + indexHtml), '');

const dist = join(FE, 'dist');
if (existsSync(dist)) {
  const maps = walk(dist).filter((f) => f.endsWith('.map'));
  add(BLOCKER, 'Exposure', 'No source maps in dist', maps.length === 0,
    maps.length ? 'A source map is the original code; devtools loads it automatically, making minification cosmetic' : '');
} else {
  add(WARN, 'Exposure', 'dist/ built', false, 'Run npm run build before deploying');
}

/* ══════════════════════════════════════════════════════════════════════════
   8. ACCESSIBILITY
   ══════════════════════════════════════════════════════════════════════════ */

for (const f of walk(join(FE, 'src/pages'))) {
  const src = read(f) ?? '';
  const h1s = (src.match(/as="h1"|<h1/g) || []).length;
  if (h1s !== 1 && /export function|export default/.test(src)) {
    add(WARN, 'Accessibility', `One h1 in ${relative(FE, f)}`, false, `Found ${h1s}`);
  }
}
add(WARN, 'Accessibility', 'Images have alt attributes',
  !/<img(?![^>]*\balt=)/.test(pageSrc), 'An <img> without alt was found');

/* ══════════════════════════════════════════════════════════════════════════
   REPORT
   ══════════════════════════════════════════════════════════════════════════ */

const blockers = results.filter((r) => r.severity === BLOCKER && !r.passed);
const warns = results.filter((r) => r.severity === WARN && !r.passed);
const passed = results.filter((r) => r.passed);

const areas = [...new Set(results.map((r) => r.area))];
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Self-check — ${esc(brief?.business?.name ?? 'generated site')}</title>
<style>
:root{--ok:#2e7d5b;--bad:#c0392b;--warn:#b8860b;--ink:#16181d;--mute:#6b7280;--rule:#e5e7eb;--bg:#fbfbfc}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:2rem 1.25rem}
.wrap{max-width:60rem;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .25rem}
.sub{color:var(--mute);margin:0 0 2rem}
.verdict{padding:1.25rem 1.5rem;border-radius:8px;margin-bottom:2rem;border:1px solid}
.verdict.pass{background:#eef7f2;border-color:#b7dfcb}
.verdict.fail{background:#fdeeec;border-color:#f2c2bb}
.verdict h2{margin:0 0 .35rem;font-size:1.1rem}
.verdict.pass h2{color:var(--ok)} .verdict.fail h2{color:var(--bad)}
.counts{display:flex;gap:1.5rem;margin:1.5rem 0;flex-wrap:wrap}
.count{flex:1;min-width:7rem;background:#fff;border:1px solid var(--rule);border-radius:8px;padding:1rem}
.count b{display:block;font-size:1.8rem;line-height:1}
.count span{color:var(--mute);font-size:.85rem}
h3{margin:2rem 0 .5rem;font-size:.8rem;letter-spacing:.09em;text-transform:uppercase;color:var(--mute)}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--rule);border-radius:8px;overflow:hidden}
td{padding:.7rem .9rem;border-top:1px solid var(--rule);vertical-align:top}
tr:first-child td{border-top:0}
.mark{width:1.5rem;font-weight:700}
.mark.ok{color:var(--ok)} .mark.bad{color:var(--bad)} .mark.warn{color:var(--warn)}
.detail{color:var(--mute);font-size:.87rem;margin-top:.2rem;white-space:pre-wrap}
footer{margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--rule);color:var(--mute);font-size:.87rem}
footer p{max-width:52ch}
</style></head><body><div class="wrap">

<h1>Self-check</h1>
<p class="sub">${esc(brief?.business?.name ?? 'Generated site')} · ${esc(industry ?? 'no preset')} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</p>

<div class="verdict ${blockers.length ? 'fail' : 'pass'}">
  <h2>${blockers.length ? `Not ready — ${blockers.length} blocker${blockers.length > 1 ? 's' : ''}` : 'All blockers passed'}</h2>
  <p style="margin:0">${blockers.length
    ? 'Fix every item marked ✗ below, then run <code>npm run selfcheck</code> again.'
    : warns.length ? `${warns.length} warning${warns.length > 1 ? 's' : ''} — review before deploying.` : 'Ready to deploy.'}</p>
</div>

<div class="counts">
  <div class="count"><b style="color:var(--ok)">${passed.length}</b><span>passed</span></div>
  <div class="count"><b style="color:var(--bad)">${blockers.length}</b><span>blockers</span></div>
  <div class="count"><b style="color:var(--warn)">${warns.length}</b><span>warnings</span></div>
</div>

${areas.map((area) => {
  const rows = results.filter((r) => r.area === area);
  return `<h3>${esc(area)}</h3><table>${rows.map((r) => `<tr>
    <td class="mark ${r.passed ? 'ok' : r.severity === BLOCKER ? 'bad' : 'warn'}">${r.passed ? '✓' : r.severity === BLOCKER ? '✗' : '!'}</td>
    <td>${esc(r.name)}${r.detail ? `<div class="detail">${esc(r.detail)}</div>` : ''}</td>
  </tr>`).join('')}</table>`;
}).join('')}

<footer>
<p><strong>Why this report is one file but the site is not.</strong></p>
<p>This report has no server behind it, so it fits in one file. That is exactly
why the site cannot: a single HTML file has no server, so it has no login, no
database, no Stripe, and no encryption. Prices end up in the markup where a
visitor can edit them, and there is no asset manifest for the 3D step to write
into.</p>
<p>For a brochure that is survivable. For a streaming service, a gym, a clinic,
or a shop it is not — the account is the product. The deliverable is a URL, and
Cursor deploys it for free on Cloudflare Pages. Nothing needs installing.</p>
</footer>

</div></body></html>`;

const out = join(ROOT, 'selfcheck-report.html');
writeFileSync(out, html);

console.log(`\n  ${blockers.length ? '✗' : '✓'}  ${passed.length} passed · ${blockers.length} blockers · ${warns.length} warnings`);
for (const b of blockers) console.log(`     ✗ [${b.area}] ${b.name}${b.detail ? `\n         ${b.detail.split('\n')[0]}` : ''}`);
console.log(`\n  Report: ${out}\n`);
console.log(`::result::${JSON.stringify({ passed: blockers.length === 0, blockers: blockers.length, warnings: warns.length })}`);

process.exit(blockers.length ? 1 : 0);
