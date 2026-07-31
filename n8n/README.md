# n8n wiring

```
supabase-schema.sql        your platform database + the trigger that starts everything
01-intake.workflow.json    import into n8n  (10 nodes)
02-qa.workflow.json        import into n8n  (19 nodes)
build-workflows.mjs        source for both — edit this, re-run it, re-import
```

| Workflow | Trigger | Does |
|---|---|---|
| `01-intake` | Webhook from the Supabase brief insert | Verifies the signature, validates the brief, seeds the placeholder manifest, kicks off Cursor |
| `02-qa` | Called by workflow 1 when Cursor reports done | Higgsfield generation, manifest swap, verification, publishes to Supabase or routes to a human |

Neither workflow talks to a live site. Workflow 1 receives a signed webhook from
Supabase; workflow 2 writes to the site's database from the build host and
redeploys. Generated sites expose no endpoint to the pipeline at all.

**Why the workflows are generated from `build-workflows.mjs` rather than
hand-edited as JSON:** the Code nodes carry real logic, and JavaScript escaped
inside a JSON string is unreviewable and unmergeable. Edit the `.mjs`, run
`node build-workflows.mjs`, re-import. The exported JSON is still a normal n8n
export — you can round-trip it through the editor, you just lose the comments.

---

## Import order

```bash
# 1. Platform database first — the workflows write to these tables.
#    Paste supabase-schema.sql into the Supabase SQL editor.

# 2. Store the two secrets in Vault (not inline in the trigger function):
#    select vault.create_secret('https://n8n.you.com/webhook/forge/brief', 'n8n_brief_url');
#    select vault.create_secret('<PLATFORM_INGEST_SECRET>',                'n8n_ingest_secret');

# 3. Build and import the workflows.
node build-workflows.mjs
#    n8n → Workflows → Import from File, for each .json

# 4. Import 02 first, copy its workflow ID into FORGE_QA_WORKFLOW_ID,
#    then activate 01. Workflow 1 calls 2 by ID, so the reverse order leaves
#    a dangling reference that only fails at runtime.
```

Then insert a row into `public.briefs` and watch it move. The trigger fires on
insert, so a manual `insert ... values (...)` in the SQL editor is a complete
end-to-end test of step 1.

---

## The build writes; the site does not listen

There is no longer an HMAC-signed `/api/_n8n/*` surface on generated sites. Those
routes were signed, rate-limited, and validated — and removed anyway, because a
permanently open write path into every production site is a standing attack
surface serving a need the build already covers.

Workflow 2 now writes a JSON artifact to the site's checkout and runs
`npm run apply`, which writes to Turso directly from the build host and then
rebuilds. Same outcome, nothing listening, and every change has a git history.

What that removes from your operational burden: no per-site HMAC secret to
derive, distribute, rotate, or leak; no clock-skew failures; no "Body Content
Type must be Raw" footgun; no signature-verification code to keep correct on
both ends.

The remaining code nodes are the Higgsfield prompt construction and the QA
parsing, below.

## Code node 3 — brief → Higgsfield jobs

Step 4. Turns `brief.three_d.subjects[]` into one generation job each, with the
material and environment context from the design direction folded into the
prompt. Higgsfield generates from the prompt alone, so anything the prompt
omits is left to chance — the direction, the material, and the intended
placement all belong in there.

```javascript
// n8n Code node — "Build Higgsfield jobs"
const brief = $json.brief;
const direction = brief.design.direction;

// Material language per direction, so the mesh arrives already close to the
// site's look instead of being corrected entirely at render time.
const DIRECTION_STYLE = {
  'kinetic-industrial':  'machined aluminium and anodised steel, hard edges, visible fasteners, industrial product render',
  'soft-optic':          'polished optical glass and soft matte polymer, smooth transitions, clean studio product render',
  'archive-editorial':   'aged patina, natural materials, museum catalogue photography, even neutral lighting',
  'liquid-chrome':       'liquid chrome, mirror finish, flowing organic surface, high reflectivity',
  'botanical-technical': 'natural organic material, matte surface, botanical specimen accuracy, soft daylight',
  'monolith':            'monolithic cast plaster and stone, matte, minimal detail, single raking light',
};

return brief.three_d.subjects.map((subject) => ({
  json: {
    asset_key: subject.key,
    must_be_accurate: subject.must_be_accurate === true,
    poly_budget: subject.poly_budget ?? 80000,
    // Prompt order matters: subject first, then material, then style, then
    // constraints. Higgsfield weights the opening tokens most heavily.
    prompt: [
      subject.prompt,
      subject.material_hint ? `${subject.material_hint} material` : '',
      DIRECTION_STYLE[direction] ?? '',
      'single isolated object, centred, neutral background, no ground plane, no text',
    ].filter(Boolean).join(', '),
  },
}));
```

Then call the Higgsfield MCP tool `generate_3d` per item, poll until each job
completes, and collect the GLB URLs.

---

## Code node 4 — Higgsfield results → manifest patch

```javascript
// n8n Code node — "Build manifest patch"
const results = $input.all().map((i) => i.json);

const assets = results.map((r) => {
  const ok = r.status === 'completed' && r.output_url;
  return {
    key: r.asset_key,
    status: ok ? 'ready' : 'failed',
    source: ok ? 'higgsfield' : 'primitive',
    url: ok ? r.output_url : null,
    poster: r.preview_url ?? null,
    bytes: r.file_size ?? undefined,
    triangles: r.triangle_count ?? undefined,
    higgsfield_job_id: r.job_id,
    prompt: r.prompt,
    error: ok ? undefined : (r.error ?? 'generation did not complete'),
  };
});

// A subject flagged must_be_accurate is the client's real product. A wrong-
// looking mesh there is worse than no mesh, so it goes to a human rather than
// shipping. Everything else falls back to its placeholder and still ships.
const needsHuman = assets.filter(
  (a) => a.status === 'failed' && results.find((r) => r.asset_key === a.key)?.must_be_accurate,
);

return [{ json: { payload: { assets, purge_cache: true }, needs_human: needsHuman, path: 'assets/upgrade' } }];
```

That `payload` is written to `<site>/.build/assets.json` and applied with
`npm run apply -- --assets ...` on the build host, which writes to Turso
directly and then triggers the frontend rebuild and redeploy.

The extra rebuild is the cost of having no runtime write endpoint. It is a
minute of CI time per site, against a permanently open write path on every
production site you ship. Worth it.

---

## Code node 5 — parse the verification result

`scripts/verify-deployment.ts` prints a machine-readable last line so you don't
have to scrape its output.

```javascript
// n8n Code node — "Parse verification"
const line = $json.stdout.split('\n').find((l) => l.startsWith('::result::'));
if (!line) throw new Error('Verification produced no result line — check stderr');

const result = JSON.parse(line.slice('::result::'.length));
return [{ json: { ...result, path: 'qa/report', payload: { run_id: $execution.id, ...result } } }];
```

Gate the "mark order complete" branch on `result.passed`. If it's false, the
brief goes back to a human queue with `result.failures` attached, and nothing
is written to the customer's Supabase account.

---

## Environment variables on the n8n side

Exactly what the two workflow files reference. Anything missing fails at
runtime with an unhelpful `undefined`, so set all of them before activating.

```
PLATFORM_INGEST_SECRET      # verifies the brief webhook from Supabase

SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY   # bypasses RLS — server-side only, never in a
                            # node whose output reaches a browser

CURSOR_AGENT_URL
CURSOR_API_KEY

HIGGSFIELD_API_URL
HIGGSFIELD_API_KEY

FORGE_TEMPLATE_REPO         # where these templates live
FORGE_SITES_ORG             # org that generated repos are created under
FORGE_SITES_DIR             # checkout path on this box, for the verify step
FORGE_QA_WORKFLOW_ID        # workflow 2's ID — workflow 1 calls it by ID
FORGE_ERROR_WORKFLOW_ID     # catches failures in both
```

Also needed on this box but not by n8n itself: `CLOUDFLARE_API_TOKEN` and
`NAMECHEAP_API_KEY`, used by `scripts/provision.ts`. Namecheap whitelists by IP,
so provisioning has to run from here rather than from a Worker.

**Only one shared secret remains:** `PLATFORM_INGEST_SECRET`, which signs the
brief webhook from Supabase into n8n and the event stream from each site back to
your dashboard. It is one-directional — it grants no ability to write into a
site — so a compromise of your n8n box cannot be turned into a write on a
client's production database.

The per-site HMAC secrets that used to exist are gone along with the endpoints
they protected. That is one fewer secret per site to derive, distribute, rotate,
and eventually leak.
