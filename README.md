# Site generation pipeline — templates and contracts

Two templates and three contracts. Fable reads this file first, then generates
against `backend/` and `frontend/` without editing either template's
architecture — only its brief-driven surfaces.

```
contracts/          brief.schema.json, asset-manifest.schema.json  (the interfaces)
backend/            Hono on Cloudflare Workers, Turso, Stripe, Zoho, n8n bridge
frontend/           Vite + React 19 + R3F, six design directions, manifest-driven 3D
SETUP.md            repo to deployed site, step by step — START HERE
.cursor/rules/      auto-applied generation rules; Cursor reads these every session
.gitignore          keeps encryption keys out of commits. Do not delete.
MANUAL-RUN.md       run the pipeline by hand, no n8n
CURSOR-PROMPT.md    the exact prompt to paste into Cursor
n8n/                Supabase platform schema + the two importable workflows
backend/SECURITY.md the threat model: what is defended, how, and what is not
```

---

## How the pieces map to your eight steps

| Your step | What actually runs |
|---|---|
| 1. Brief → webhook → Supabase → n8n | Validate against `contracts/brief.schema.json`. Reject early; a malformed brief that reaches step 3 wastes a full generation cycle. |
| 2. n8n pairs brief + backend template | Backend needs no per-brief code changes. n8n rewrites `wrangler.toml` vars and pushes secrets. |
| 3. Cursor + Fable generate | Fable writes `frontend/src/site.config.ts`, `index.html` meta, page components, and `assets.manifest.json` with `status:"placeholder"`. |
| 4. Higgsfield 3D swap | n8n writes the GLB results to a file and runs `npm run apply`, which updates the site database from the build host and rebuilds. **No component or import is edited** — one JSON write, then a deploy. |
| 5. Fable bug + quality check | Run the checklist below. `npm run build` must pass with no chunk over budget. |
| 6. Second n8n automation tests | `scripts/verify-deployment.ts` — asserts headers, auth boundaries, signature rejection, rate limiting. Emits `::result::` JSON. |
| 7. Approved → saved to Supabase | Gate on `result.passed`. Site events flow *outward* via the outbox — one direction only. |
| 8. Client views in dashboard | Your dashboard reads Supabase; each site reports status through `PLATFORM_INGEST_URL`. |

**Database split, deliberately:** Supabase holds *your* platform data — accounts,
orders, briefs, which customer owns which site. Turso holds *one site's* data,
one database per site. A generated site never has a credential that can read
another client's anything, and any single site's database can be handed to its
owner without extraction work.

---

## What Fable may and may not change

**Rewrite freely (brief-driven):**
- `frontend/src/site.config.ts` — every field
- `frontend/index.html` — title, description, OG tags, JSON-LD, domain
- `frontend/src/pages/*`, `frontend/src/sections/*` — compose from `brief.site.pages[].sections`
- `frontend/src/data/assets.manifest.json` — one entry per `three_d.subjects[]`
- `frontend/src/styles/directions.css` — only to *add* a direction block
- `backend/wrangler.toml` — `name`, `routes`, `[vars]`

**Do not change:**
- `backend/src/middleware/*` — security posture is uniform across every site
- `backend/src/lib/crypto.ts`, `totp.ts`, `encryption.ts`, `audit-chain.ts`, `ssrf.ts` — hand-modified crypto is how sites get breached
- `backend/src/db/client.ts` — the `@libsql/client/web` import is load-bearing
- `frontend/src/three/*` — the quality gate and manifest indirection are what
  keep a 3D site fast; a "simplification" here is how it becomes slow
- Any `contracts/*.schema.json` — these are the interfaces between steps

**Never:** invent an asset URL, hardcode a price in the frontend, add a secret
to any file under `frontend/`, or write placeholder copy.

---

## Six design directions

`brief.design.direction` selects one; components read tokens only and never
branch on the direction name.

| Direction | Fits | Signature move |
|---|---|---|
| `kinetic-industrial` | manufacturing, hardware, robotics | orange used only as a live-state indicator, never decoration |
| `soft-optic` | optics, medical devices, skincare | the 3D subject refracts the page behind it |
| `archive-editorial` | galleries, publishers, institutes | accession-number rail that tracks scroll position |
| `liquid-chrome` | fashion, music, launches | the model *is* the background; type knocked out over it |
| `botanical-technical` | food, agriculture, sustainability | hairline leader lines to real annotations |
| `monolith` | architecture, law, consultancies | inverted hierarchy — huge type, small object, no accent colour |

Each pack sets palette, three type roles, spatial rhythm **and 3D lighting
bias**. That last part is why generated models look art-directed here rather
than pasted on: a chrome-direction site relights the mesh as a mirror, a
botanical one as matte organic material, from the same GLB.

Client brand colours in `brief.design.palette_locks` override the pack's accent
and survive intact.

---

## The 3D pipeline, concretely

```
brief.three_d.subjects[]
   → assets.manifest.json  (status: "placeholder", a primitive shape)
   → site generates, renders, looks complete
   → Higgsfield returns GLBs
   → npm run apply -- --assets results.json   (build host, direct to Turso)
   → status: "ready" + url, frontend rebuilt and redeployed
   → real mesh served, zero layout shift
```

Nothing imports a model URL. `getAsset('hero_subject')` is the only access path,
so the step-4 swap is a data change and never a code edit — which is what makes
it safe to automate.

Performance decisions that matter more than they look:

- **three.js is behind a lazy import gated on capability.** `quality.ts` imports
  nothing from three, so a device with no WebGL, `prefers-reduced-motion`,
  save-data, or a software rasteriser never downloads the ~600 kB chunk.
- **`frameloop="demand"`** — idle unless something invalidates. On a page of
  slowly drifting models this is roughly an order of magnitude less GPU time
  than a permanent 60 fps loop.
- **DPR clamped by measured tier.** Retina at DPR 3 is nine times the fragment
  work of DPR 1 for a difference most people cannot see on a moving object.
- **Autofit normalisation.** Generated meshes arrive anywhere from 0.02 to 340
  units tall. Every model is fitted to a unit box before the brief's scale hint
  is applied, so regenerating an asset cannot break the layout.
- **Runtime downgrade.** A device can pass every static check and still
  thermally throttle two minutes in; `PerformanceMonitor` drops a tier when
  measured frame time stays bad.
- **Context-loss recovery.** Sleep a laptop with a live canvas and the GPU
  context is gone. Without the handler the site is a black rectangle until
  reload.
- **Materials cloned before mutation.** `useGLTF` caches by URL, so mutating the
  returned scene mutates every other instance — a bug that only appears once
  one asset is reused in two places.

---

## Step-5 quality checklist

Fable runs this before handing to step 6. Blockers stop the release.

**Build**
- [ ] `npm run typecheck` clean in both templates
- [ ] `npm run build && npm run budget` passes — this asserts three.js is *outside*
      the entry chunk, sizes are inside budget, and no secret, placeholder token,
      or lorem text survived into the bundle
- [ ] every 3D asset has a poster (`npm run budget` treats a missing one as a blocker)

**Content**
- [ ] every string traces to the brief; no invented client facts, stats, or testimonials
- [ ] every `<img>` has `alt`; every canvas has `role="img"` + `aria-label`
- [ ] one `<h1>` per page, headings not skipped

**3D**
- [ ] every manifest entry is `ready` or a deliberate `client_supplied`
- [ ] every entry has a `poster` (blocker — it is the no-WebGL fallback)
- [ ] hero ≤ 120 k triangles, inline ≤ 40 k
- [ ] page renders correctly with WebGL disabled

**Security** (`scripts/verify-deployment.ts` asserts all of these)
- [ ] CSP present and nonce-based, HSTS ≥ 2 years, nosniff, frame-deny
- [ ] `/api/admin/*` returns 401 anonymously
- [ ] Stripe webhook rejects an unsigned body
- [ ] no build-pipeline endpoint is reachable — `/api/_n8n/*` must 404
- [ ] every privileged account has MFA enabled
- [ ] `/api/admin/security/posture` reports no `critical` finding
- [ ] login rate limit engages
- [ ] no `sk_live`, `whsec_`, or auth token anywhere in the client bundle

**Commerce** (if `integrations.stripe.enabled`)
- [ ] prices resolve server-side from the `products` table only
- [ ] test-mode checkout completes and writes a `paid` order
- [ ] replaying one webhook twice produces one order

**Accessibility**
- [ ] keyboard reaches every control, focus always visible
- [ ] contrast ≥ 4.5:1 body, ≥ 3:1 large text
- [ ] `prefers-reduced-motion` stops the canvas, not just CSS transitions

---

## Setup order for a new site

```bash
# 1. domain, Cloudflare zone, DNS, Turso database  (static-IP host — Namecheap
#    whitelists by IP, which is exactly why this is not a Worker route)
cd backend && tsx scripts/provision.ts --brief ./brief.json        # add --live to actually buy

# 2. schema  (0001 core, 0002 security layer)
npm run migrate

# 2b. generate the encryption keyring — do this ONCE per site and keep it safe
node -e "console.log('DATA_ENCRYPTION_KEYS=k'+new Date().toISOString().slice(0,7).replace('-','')+':'+require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('BLIND_INDEX_KEY='+require('crypto').randomBytes(32).toString('base64url'))"

# 3. Stripe catalog + webhook endpoint  (prints STRIPE_WEBHOOK_SECRET exactly once)
npm run seed:stripe -- --brief ./brief.json --webhook https://theclient.com

# 4. secrets  (only the Worker-safe subset is pushed; Namecheap keys stay off the edge)
tsx scripts/push-secrets.ts --file .dev.vars

# 5. ship
npx wrangler deploy
cd ../frontend && npm run build && npm run budget
npx wrangler pages deploy dist

# 6. prove it
cd ../backend && npm run verify -- --origin https://theclient.com
```

`npm run budget` and `npm run verify` both end with a `::result::{...}` line, so
workflow 2 parses a verdict instead of scraping human-readable output. Both exit
non-zero on failure, so an Execute Command node fails the branch on its own.

The n8n side is in `n8n/` — Supabase schema first, then the two workflow files.

---

## Security

Full detail in `backend/SECURITY.md`. The headline decisions:

**Generated sites expose no endpoint to the build pipeline.** An earlier version
had HMAC-signed `/api/_n8n/*` routes so n8n could push assets and QA verdicts
into a running site. They are gone. The pipeline builds; once deployed, nothing
outside a site can write to it except Stripe (signature-verified) and its own
authenticated users. Assets and content are applied by
`scripts/apply-build-artifacts.ts` on the build host, before traffic reaches the
deploy.

Beyond that, every generated site ships with:

- **TOTP two-factor** with the secret encrypted at rest, single-use per counter, and hashed single-use recovery codes
- **Step-up authentication** — a fresh proof of identity within 10 minutes for anything irreversible, money-moving, or bulk-PII
- **Field-level AES-256-GCM** for personal data, with a versioned keyring and AAD binding each ciphertext to its own row and column
- **Breached-password screening** via HIBP k-anonymity — the single highest-value password control there is
- **Session binding and anomaly detection**, graded so that travellers stay logged in and cloned browsers do not
- **Tamper-evident audit log** — hash-chained, verified nightly, head anchored off-site
- **SSRF egress guard** re-validating after every redirect
- **Trusted Types**, nonce CSP with live violation reporting, COOP/COEP/CORP, HSTS preload
- **GDPR export and erasure**, with financial records retained under Article 17(3)
- **Break-glass lockdown** — read-only rather than offline, so an incident does not become an outage
- **Continuous posture check** at `/api/admin/security/posture`
- **Honeytokens** — decoy paths and canary credentials that fire only when someone is already inside
- **CI security pipeline** — dependency audit, SBOM, full-history secret scan, bundle exposure checks, and an assertion that the security middleware was not modified during generation

**On "nothing visible in F12":** devtools cannot be blocked, and no generated
site claims to. What the template does instead is make sure there is nothing
worth finding — no source maps, no console calls, no key material, mangled
top-level names, and `GET /api` returning nothing in production instead of
listing every route. `frontend/src/lib/protect.ts` adds opt-in copy deterrence
for clients who want it, with honest disclosure text so nobody is sold a
guarantee that cannot exist.

Card data never touches the backend — Stripe Checkout is hosted, keeping PCI
scope at SAQ-A.

`SECURITY.md` also lists the deliberate trade-offs (three controls fail *open*,
and why) and what is **not** covered — WebAuthn, pen testing, backups, supply
chain. Read that section before selling against a competitor on security.

---

## Things that will bite you, written down so they don't

1. **`@libsql/client/web`, not `@libsql/client`.** The default build opens a
   WebSocket and touches `node:fs`; neither exists on Workers. Most common cause
   of a Turso-backed Worker failing to deploy.
2. **Stripe needs `createFetchHttpClient()` and `constructEventAsync`.** The sync
   verifier cannot work on Workers — Workers only exposes async crypto. This is
   the classic "works locally, 500s in production".
3. **Namecheap requires IP whitelisting and returns XML.** Workers have no
   stable egress IP. Registration is a provisioning script, not a route.
4. **SMTP is impossible from Workers** (no raw TCP on 587). Transactional mail
   goes over ZeptoMail's HTTP API. Mailbox creation is a separate OAuth path at
   provisioning time.
5. **Rate limiting needs a Durable Object, not KV.** KV is eventually consistent
   across colos, so a KV limit can be exceeded by roughly the number of edge
   locations an attacker can reach.
6. **`DATA_ENCRYPTION_KEYS` is a keyring, newest first.** Rotate by *prepending*
   a key, never by replacing one — removing a key before its rows are
   re-encrypted makes those rows permanently unreadable. Changing
   `BLIND_INDEX_KEY` invalidates every stored index and requires a reindex.
7. **Stripe webhooks return 200 even on internal failure.** A non-2xx makes
   Stripe retry, and a poison event then retries forever. Failures are recorded
   in `webhook_events` and surfaced in the admin dashboard instead.
8. **Zoho DKIM cannot be automated end to end.** Zoho generates the key; you
   publish the selector. `provision.ts` flags it as a manual step rather than
   silently shipping a domain that fails DMARC alignment.
9. **Cookies are `__Host-` prefixed.** They cannot be set by a subdomain or over
   http — which matters because every site has an `admin.` subdomain.
10. **Password reset revokes all sessions.** Otherwise a stolen session survives
    the exact action taken to stop it. Enabling MFA does the same.
11. **An unanchored audit chain is a speed bump.** Hash chaining makes tampering
    *detectable*; an attacker with write access can recompute the tail. Set
    `PLATFORM_INGEST_URL` so the nightly job ships the head somewhere the site
    cannot write. The admin endpoint says so explicitly rather than showing a
    reassuring green tick.
12. **Turso point-in-time recovery is a platform setting and is not configured
    here.** Configure it. An unrecoverable database beats every control in
    `SECURITY.md` for total damage caused.
