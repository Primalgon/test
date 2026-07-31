#!/usr/bin/env node
/**
 * Emits 01-intake.workflow.json and 02-qa.workflow.json.
 *
 *   node build-workflows.mjs
 *
 * The workflows are kept as source here rather than as hand-edited JSON because
 * the Code nodes carry real logic, and JSON-escaped JavaScript inside a JSON
 * string is unreviewable. Edit this file, re-run it, re-import.
 */
import { writeFileSync } from 'node:fs';

let idc = 0;
const nid = (p) => `${p}-${(++idc).toString().padStart(4, '0')}`;

const node = (name, type, typeVersion, position, parameters = {}, extra = {}) => ({
  parameters,
  id: nid('n'),
  name,
  type,
  typeVersion,
  position,
  ...extra,
});

const code = (name, position, jsCode, mode = 'runOnceForAllItems') =>
  node(name, 'n8n-nodes-base.code', 2, position, { mode, jsCode });

const http = (name, position, parameters) =>
  node(name, 'n8n-nodes-base.httpRequest', 4.2, position, { options: {}, ...parameters });

const link = (pairs) => {
  const out = {};
  for (const [from, to, outputIndex = 0] of pairs) {
    out[from] ??= { main: [] };
    while (out[from].main.length <= outputIndex) out[from].main.push([]);
    out[from].main[outputIndex].push({ node: to, type: 'main', index: 0 });
  }
  return out;
};

/* ================================================================== *
 * Shared code fragments
 * ================================================================== */

const WRITE_ARTIFACT_FRAGMENT = `
// Write the payload to a file for the build host to apply.
//
// This used to sign an HMAC and POST to /api/_n8n/* on the live site. Those
// endpoints are gone: a permanently open write path into every production site
// is not worth the convenience, and the build host already holds the site's
// database credentials directly. Same result, no listening endpoint, and every
// change leaves a git history.
const fs = require('fs');
const path = require('path');

const dir = path.join($env.FORGE_SITES_DIR, $json.site_slug, '.build');
fs.mkdirSync(dir, { recursive: true });

const file = path.join(dir, $json.artifact + '.json');
fs.writeFileSync(file, JSON.stringify($json.payload, null, 2));

return [{ json: { ...$json, artifact_path: file } }];
`.trim();

/* ================================================================== *
 * Workflow 1 — intake
 * ================================================================== */

const intakeNodes = [
  node('Brief received', 'n8n-nodes-base.webhook', 2, [-460, 300], {
    httpMethod: 'POST',
    path: 'forge/brief',
    responseMode: 'responseNode',
    options: { rawBody: true },
  }, { webhookId: 'forge-brief-intake' }),

  code('Verify + validate brief', [-240, 300], `
// Two jobs: prove the call came from your platform, and prove the brief is
// usable. A malformed brief that reaches step 3 wastes an entire generation
// cycle, so it is rejected here where rejection is free.
const crypto = require('crypto');

const raw = typeof $json.body === 'string' ? $json.body : JSON.stringify($json.body);
const headers = $json.headers || {};
const ts = headers['x-forge-timestamp'];
const provided = String(headers['x-forge-signature'] || '').replace(/^sha256=/, '');

if (!ts || !provided) throw new Error('Missing signature headers');
if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
  throw new Error('Timestamp outside tolerance — replay attempt or clock skew');
}

const expected = crypto.createHmac('sha256', $env.PLATFORM_INGEST_SECRET)
  .update(ts + '.' + raw).digest('hex');
const a = Buffer.from(expected, 'hex');
const b = Buffer.from(provided, 'hex');
// A plain === on a signature leaks timing information one byte at a time.
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Bad signature');

const brief = JSON.parse(raw);

// Validation. Not the full JSON Schema — that runs in the next node against
// contracts/brief.schema.json. These are the fields without which nothing
// downstream can even start.
const problems = [];
const need = (p, v) => { if (v === undefined || v === null || v === '') problems.push('missing ' + p); };

need('brief_id', brief.brief_id);
need('order_id', brief.order_id);
need('account_id', brief.account_id);
need('business.name', brief.business?.name);
need('business.one_liner', brief.business?.one_liner);
need('site.domain.desired', brief.site?.domain?.desired);
need('design.direction', brief.design?.direction);

const DIRECTIONS = ['kinetic-industrial','soft-optic','archive-editorial','liquid-chrome','botanical-technical','monolith'];
if (brief.design?.direction && !DIRECTIONS.includes(brief.design.direction)) {
  problems.push('design.direction "' + brief.design.direction + '" is not one of the six packs');
}

if (!Array.isArray(brief.site?.pages) || brief.site.pages.length === 0) {
  problems.push('site.pages must list at least one page');
}

if (brief.three_d?.required && !(brief.three_d.subjects || []).length) {
  problems.push('three_d.required is true but three_d.subjects is empty');
}
for (const s of brief.three_d?.subjects || []) {
  if (!/^[a-z0-9_]+$/.test(s.key || '')) problems.push('three_d subject key "' + s.key + '" must be lower_snake_case');
  // Under about fifteen words Higgsfield returns something generic. The brief
  // form should enforce this, but briefs arrive from other places too.
  if ((s.prompt || '').split(/\\s+/).length < 12) {
    problems.push('three_d subject "' + s.key + '" prompt is too thin to generate a specific mesh');
  }
}

if (brief.integrations?.stripe?.enabled) {
  const skus = (brief.integrations.stripe.products || []).map((p) => p.sku);
  if (new Set(skus).size !== skus.length) problems.push('duplicate SKUs in integrations.stripe.products');
  for (const p of brief.integrations.stripe.products || []) {
    if (!Number.isInteger(p.amount_cents) || p.amount_cents < 0) {
      problems.push('product ' + p.sku + ' amount_cents must be a non-negative integer (cents, not dollars)');
    }
  }
}

const slug = String(brief.site.domain.desired).replace(/^https?:\\/\\//, '').split('/')[0]
  .replace(/\\./g, '-').toLowerCase();

return [{
  json: {
    brief,
    brief_id: brief.brief_id,
    account_id: brief.account_id,
    order_id: brief.order_id,
    site_slug: slug,
    site_origin: 'https://' + brief.site.domain.desired,
    valid: problems.length === 0,
    problems,
  },
}];
`.trim()),

  node('Valid?', 'n8n-nodes-base.if', 2, [-20, 300], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'valid-check',
        leftValue: '={{ $json.valid }}',
        rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  }),

  http('Supabase — mark validating', [200, 200], {
    method: 'PATCH',
    url: "={{ $env.SUPABASE_URL }}/rest/v1/briefs?brief_id=eq.{{ $json.brief_id }}",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'apikey', value: '={{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
        { name: 'Authorization', value: '=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Prefer', value: 'return=representation' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ status: "generating", site_slug: $json.site_slug, validated_at: new Date().toISOString() }) }}',
  }),

  http('Supabase — reject brief', [200, 420], {
    method: 'PATCH',
    url: "={{ $env.SUPABASE_URL }}/rest/v1/briefs?brief_id=eq.{{ $json.brief_id }}",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'apikey', value: '={{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
        { name: 'Authorization', value: '=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ status: "needs_revision", validation_problems: $json.problems, validated_at: new Date().toISOString() }) }}',
  }),

  code('Build generation payload', [420, 200], `
// What Cursor/Fable receives: the brief, the template contract, and the
// explicit boundary of what may be edited. Restating the boundary in the
// payload matters — the model reads this far more reliably than it reads a
// README that happens to be in the repo.
const brief = $('Verify + validate brief').first().json.brief;
const slug = $('Verify + validate brief').first().json.site_slug;

const subjects = brief.three_d?.subjects || [];

// The manifest is written NOW, with placeholders, before any 3D exists. That
// is what lets generation and asset production run in parallel instead of
// serially, and it is why the step-4 swap needs no code change.
const manifest = {
  version: 1,
  site: slug,
  generated_at: new Date().toISOString(),
  assets: Object.fromEntries(subjects.map((s) => [s.key, {
    key: s.key,
    status: 'placeholder',
    source: 'primitive',
    url: null,
    poster: null,
    placement: s.placement || 'inline',
    primitive: s.material_hint === 'glass' ? 'icosahedron'
             : s.material_hint === 'metal' ? 'torus_knot'
             : 'rounded_box',
    transform: { scale: s.scale_hint || 1, autofit: true, position: [0, 0, 0], rotation: [0, 0, 0] },
    animation: s.placement === 'hero' ? 'pointer_parallax' : 'scroll_scrub',
    budget: { max_triangles: s.poly_budget || 80000, max_bytes: 6000000 },
    alt: s.prompt.slice(0, 160),
  }])),
};

return [{
  json: {
    site_slug: slug,
    site_origin: 'https://' + brief.site.domain.desired,
    brief_id: brief.brief_id,
    account_id: brief.account_id,
    order_id: brief.order_id,
    generation_request: {
      brief,
      template_repo: $env.FORGE_TEMPLATE_REPO,
      target_repo: $env.FORGE_SITES_ORG + '/' + slug,
      instructions_path: 'README.md',
      write_files: [
        'frontend/src/site.config.ts',
        'frontend/index.html',
        'frontend/src/pages/*',
        'frontend/src/sections/*',
        'frontend/src/data/assets.manifest.json',
        'backend/wrangler.toml',
      ],
      do_not_touch: [
        'backend/src/middleware/*',
        'backend/src/lib/crypto.ts',
        'backend/src/db/client.ts',
        'frontend/src/three/*',
        'contracts/*',
      ],
      seed_manifest: manifest,
      direction: brief.design.direction,
      acceptance: [
        'npm run typecheck passes in both templates',
        'npm run build then npm run budget passes with three.js outside the entry chunk',
        'no placeholder token, lorem text, or invented client fact survives',
        'every string traces to a field of the brief',
      ],
    },
  },
}];
`.trim()),

  http('Cursor — start generation', [640, 200], {
    method: 'POST',
    url: '={{ $env.CURSOR_AGENT_URL }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: '=Bearer {{ $env.CURSOR_API_KEY }}' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.generation_request) }}',
    options: {
      // Generation is minutes, not seconds. The default 5-minute timeout ends
      // the run while the agent is still working and n8n reports a failure for
      // a job that in fact succeeded.
      timeout: 1800000,
      response: { response: { neverError: true, responseFormat: 'json' } },
    },
  }),

  code('Check generation result', [860, 200], `
const res = $json;
const ctx = $('Build generation payload').first().json;

const ok = res.status === 'completed' || res.success === true;
if (!ok) {
  throw new Error('Generation did not complete: ' + JSON.stringify(res).slice(0, 500));
}

return [{
  json: {
    ...ctx,
    repo_url: res.repo_url || res.output?.repo_url,
    commit_sha: res.commit_sha || res.output?.commit_sha,
    brief: $('Verify + validate brief').first().json.brief,
  },
}];
`.trim()),

  node('Hand off to QA workflow', 'n8n-nodes-base.executeWorkflow', 1.2, [1080, 200], {
    workflowId: { __rl: true, value: '={{ $env.FORGE_QA_WORKFLOW_ID }}', mode: 'id' },
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [] },
    options: { waitForSubWorkflow: false },
  }),

  node('Respond', 'n8n-nodes-base.respondToWebhook', 1.1, [1300, 300], {
    respondWith: 'json',
    responseBody: '={{ JSON.stringify({ accepted: $json.valid !== false, brief_id: $json.brief_id, problems: $json.problems || [] }) }}',
    options: { responseCode: 202 },
  }),
];

const intake = {
  name: 'Forge 01 — brief intake and generation',
  nodes: intakeNodes,
  connections: link([
    ['Brief received', 'Verify + validate brief'],
    ['Verify + validate brief', 'Valid?'],
    ['Valid?', 'Supabase — mark validating', 0],
    ['Valid?', 'Supabase — reject brief', 1],
    ['Supabase — mark validating', 'Build generation payload'],
    ['Supabase — reject brief', 'Respond'],
    ['Build generation payload', 'Cursor — start generation'],
    ['Cursor — start generation', 'Check generation result'],
    ['Check generation result', 'Hand off to QA workflow'],
    ['Hand off to QA workflow', 'Respond'],
  ]),
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
    // A failed intake must be visible. Silent failure here means a paying
    // customer waits for a site that no process is building.
    errorWorkflow: '={{ $env.FORGE_ERROR_WORKFLOW_ID }}',
    timezone: 'UTC',
  },
  pinData: {},
  meta: { instanceId: 'forge' },
  tags: [{ name: 'forge' }],
};

/* ================================================================== *
 * Workflow 2 — 3D swap, deploy, QA
 * ================================================================== */

const qaNodes = [
  node('Called by workflow 1', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [-460, 300], {
    inputSource: 'passthrough',
  }),

  code('Build Higgsfield jobs', [-240, 300], `
// Step 4. One generation job per brief subject, with the direction's material
// and lighting language folded into the prompt. Higgsfield generates from the
// prompt alone — anything the prompt omits is left to chance, so the material,
// the direction and the intended isolation all belong in there.
const brief = $json.brief;
const direction = brief.design.direction;

const DIRECTION_STYLE = {
  'kinetic-industrial':  'machined aluminium and anodised steel, hard edges, visible fasteners, industrial product render',
  'soft-optic':          'polished optical glass and soft matte polymer, smooth transitions, clean studio product render',
  'archive-editorial':   'aged patina, natural materials, museum catalogue photography, even neutral lighting',
  'liquid-chrome':       'liquid chrome, mirror finish, flowing organic surface, high reflectivity',
  'botanical-technical': 'natural organic material, matte surface, botanical specimen accuracy, soft daylight',
  'monolith':            'monolithic cast plaster and stone, matte, minimal detail, single raking light',
};

return (brief.three_d?.subjects || []).map((subject) => ({
  json: {
    ...$json,
    asset_key: subject.key,
    must_be_accurate: subject.must_be_accurate === true,
    poly_budget: subject.poly_budget || 80000,
    // Prompt order matters — the opening tokens are weighted most heavily, so
    // the subject leads and the constraints trail.
    prompt: [
      subject.prompt,
      subject.material_hint ? subject.material_hint + ' material' : '',
      DIRECTION_STYLE[direction] || '',
      'single isolated object, centred, neutral background, no ground plane, no text',
    ].filter(Boolean).join(', '),
  },
}));
`.trim()),

  node('One subject at a time', 'n8n-nodes-base.splitInBatches', 3, [-20, 300], {
    batchSize: 1,
    options: {},
  }),

  http('Higgsfield — generate 3D', [200, 420], {
    method: 'POST',
    url: '={{ $env.HIGGSFIELD_API_URL }}/v1/3d/generate',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: '=Bearer {{ $env.HIGGSFIELD_API_KEY }}' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ prompt: $json.prompt, format: "glb", target_triangles: $json.poly_budget, texture_resolution: 2048 }) }}',
    options: { response: { response: { neverError: true, responseFormat: 'json' } } },
  }),

  node('Wait for mesh', 'n8n-nodes-base.wait', 1.1, [420, 420], {
    amount: 20,
    unit: 'seconds',
  }, { webhookId: 'forge-higgsfield-wait' }),

  http('Higgsfield — poll job', [640, 420], {
    method: 'GET',
    url: '={{ $env.HIGGSFIELD_API_URL }}/v1/jobs/{{ $json.job_id || $json.id }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Authorization', value: '=Bearer {{ $env.HIGGSFIELD_API_KEY }}' }],
    },
    options: { response: { response: { neverError: true, responseFormat: 'json' } } },
  }),

  node('Mesh ready?', 'n8n-nodes-base.if', 2, [860, 420], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{
        id: 'terminal-state',
        leftValue: '={{ ["completed","failed","cancelled"].includes($json.status) }}',
        rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  }),

  code('Collect result', [1080, 340], `
// One row per asset, whatever the outcome. A failed subject still produces a
// row so the manifest patch is complete and the site keeps its placeholder
// rather than losing the entry entirely.
const r = $json;
const job = $('One subject at a time').first().json;

return [{
  json: {
    asset_key: job.asset_key,
    must_be_accurate: job.must_be_accurate,
    prompt: job.prompt,
    status: r.status,
    output_url: r.output?.glb_url || r.output_url || null,
    preview_url: r.output?.preview_url || r.preview_url || null,
    triangle_count: r.output?.triangle_count ?? null,
    file_size: r.output?.bytes ?? null,
    job_id: r.job_id || r.id,
    error: r.error || null,
  },
}];
`.trim()),

  code('Build manifest patch', [-240, 620], `
// Everything the loop collected, turned into the body of /assets/upgrade.
const results = $('Collect result').all().map((i) => i.json);
const ctx = $('Called by workflow 1').first().json;

const assets = results.map((r) => {
  const ok = r.status === 'completed' && r.output_url;
  return {
    key: r.asset_key,
    status: ok ? 'ready' : 'failed',
    source: ok ? 'higgsfield' : 'primitive',
    url: ok ? r.output_url : null,
    poster: r.preview_url || null,
    bytes: r.file_size ?? undefined,
    triangles: r.triangle_count ?? undefined,
    higgsfield_job_id: r.job_id,
    prompt: r.prompt,
    error: ok ? undefined : (r.error || 'generation did not complete'),
  };
});

// A subject flagged must_be_accurate is the client's actual product. A
// wrong-looking mesh there is worse than no mesh, so it goes to a human
// instead of shipping. Everything else falls back to its placeholder and the
// site still ships on time.
const needsHuman = assets.filter((a) => {
  const src = results.find((r) => r.asset_key === a.key);
  return a.status === 'failed' && src?.must_be_accurate;
});

return [{
  json: {
    ...ctx,
    artifact: 'assets',
    payload: { assets },
    needs_human: needsHuman,
    assets_ready: assets.filter((a) => a.status === 'ready').length,
    assets_total: assets.length,
  },
}];
`.trim()),

  code('Write manifest artifact', [-20, 620], WRITE_ARTIFACT_FRAGMENT),

  node('Apply assets + rebuild', 'n8n-nodes-base.executeCommand', 1, [200, 620], {
    // Applied to the database, then the frontend is rebuilt and redeployed.
    // The rebuild is what makes the swap visible — the site has no runtime path
    // to overwrite its own assets, by design.
    command: '=cd $FORGE_SITES_DIR/{{ $json.site_slug }}/backend'
      + ' && npm run apply -- --assets {{ $json.artifact_path }} --manifest ../frontend/src/data/assets.manifest.json'
      + ' && cd ../frontend && npm run build && npm run budget'
      + ' && npx wrangler pages deploy dist --project-name {{ $json.site_slug }}',
  }),

  node('Run verification', 'n8n-nodes-base.executeCommand', 1, [420, 620], {
    command: '=cd $FORGE_SITES_DIR/{{ $(\'Build manifest patch\').first().json.site_slug }}/backend && npm run verify -- --origin {{ $(\'Build manifest patch\').first().json.site_origin }}',
  }),

  code('Parse verification', [640, 620], `
// verify-deployment.ts prints a machine-readable last line specifically so
// nothing here has to scrape human-facing output.
const ctx = $('Build manifest patch').first().json;
const stdout = $json.stdout || '';

const line = stdout.split('\\n').find((l) => l.startsWith('::result::'));
if (!line) {
  throw new Error('Verification produced no ::result:: line. stderr: ' + String($json.stderr || '').slice(0, 800));
}
const result = JSON.parse(line.slice('::result::'.length));

// An asset the client cares about failing to generate is a release blocker
// even when every security check passed.
const blockers = [...(result.failures || [])];
for (const a of ctx.needs_human) {
  blockers.push({ check: 'asset.' + a.key, severity: 'blocker', detail: 'must_be_accurate subject failed to generate: ' + (a.error || 'unknown') });
}

const passed = result.passed && blockers.length === (result.failures || []).length && ctx.needs_human.length === 0;

return [{
  json: {
    ...ctx,
    artifact: 'qa',
    passed,
    payload: {
      run_id: $execution.id,
      passed,
      score: result.score ?? null,
      failures: blockers,
    },
    verification: result,
  },
}];
`.trim()),

  code('Write QA artifact', [860, 620], WRITE_ARTIFACT_FRAGMENT),

  node('Record QA verdict', 'n8n-nodes-base.executeCommand', 1, [1080, 620], {
    command: '=cd $FORGE_SITES_DIR/{{ $json.site_slug }}/backend'
      + ' && npm run apply -- --qa {{ $json.artifact_path }}',
  }),

  node('Passed?', 'n8n-nodes-base.if', 2, [-460, 900], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: 'qa-passed',
        leftValue: "={{ $('Parse verification').first().json.passed }}",
        rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  }),

  http('Supabase — publish to account', [-240, 800], {
    method: 'POST',
    url: '={{ $env.SUPABASE_URL }}/rest/v1/sites',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'apikey', value: '={{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
        { name: 'Authorization', value: '=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
        { name: 'Content-Type', value: 'application/json' },
        // Upsert. A re-run after a fixed failure must update the row, not add
        // a second site to the customer's dashboard.
        { name: 'Prefer', value: 'resolution=merge-duplicates,return=representation' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
      account_id: $('Parse verification').first().json.account_id,
      brief_id: $('Parse verification').first().json.brief_id,
      order_id: $('Parse verification').first().json.order_id,
      slug: $('Parse verification').first().json.site_slug,
      origin: $('Parse verification').first().json.site_origin,
      status: 'live',
      assets_ready: $('Parse verification').first().json.assets_ready,
      assets_total: $('Parse verification').first().json.assets_total,
      qa_score: $('Parse verification').first().json.verification.score,
      published_at: new Date().toISOString()
    }) }}`,
  }),

  http('Supabase — flag for review', [-240, 1020], {
    method: 'PATCH',
    url: "={{ $env.SUPABASE_URL }}/rest/v1/briefs?brief_id=eq.{{ $('Parse verification').first().json.brief_id }}",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'apikey', value: '={{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
        { name: 'Authorization', value: '=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
      status: 'needs_human',
      qa_failures: $('Parse verification').first().json.payload.failures,
      reviewed_at: null,
      updated_at: new Date().toISOString()
    }) }}`,
  }),

  node('Done', 'n8n-nodes-base.noOp', 1, [-20, 900], {}),
];

const qa = {
  name: 'Forge 02 — 3D swap, verify, publish',
  nodes: qaNodes,
  connections: link([
    ['Called by workflow 1', 'Build Higgsfield jobs'],
    ['Build Higgsfield jobs', 'One subject at a time'],
    // splitInBatches output 0 is "done", output 1 is "loop".
    ['One subject at a time', 'Build manifest patch', 0],
    ['One subject at a time', 'Higgsfield — generate 3D', 1],
    ['Higgsfield — generate 3D', 'Wait for mesh'],
    ['Wait for mesh', 'Higgsfield — poll job'],
    ['Higgsfield — poll job', 'Mesh ready?'],
    ['Mesh ready?', 'Collect result', 0],
    ['Mesh ready?', 'Wait for mesh', 1],
    ['Collect result', 'One subject at a time'],
    ['Build manifest patch', 'Write manifest artifact'],
    ['Write manifest artifact', 'Apply assets + rebuild'],
    ['Apply assets + rebuild', 'Run verification'],
    ['Run verification', 'Parse verification'],
    ['Parse verification', 'Write QA artifact'],
    ['Write QA artifact', 'Record QA verdict'],
    ['Record QA verdict', 'Passed?'],
    ['Passed?', 'Supabase — publish to account', 0],
    ['Passed?', 'Supabase — flag for review', 1],
    ['Supabase — publish to account', 'Done'],
    ['Supabase — flag for review', 'Done'],
  ]),
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
    errorWorkflow: '={{ $env.FORGE_ERROR_WORKFLOW_ID }}',
    timezone: 'UTC',
  },
  pinData: {},
  meta: { instanceId: 'forge' },
  tags: [{ name: 'forge' }],
};

writeFileSync('01-intake.workflow.json', JSON.stringify(intake, null, 2) + '\n');
writeFileSync('02-qa.workflow.json', JSON.stringify(qa, null, 2) + '\n');

console.log(`Wrote 01-intake.workflow.json (${intake.nodes.length} nodes)`);
console.log(`Wrote 02-qa.workflow.json (${qa.nodes.length} nodes)`);
