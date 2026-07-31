# Manual run — Cursor + Higgsfield, no n8n

For testing the pipeline by hand before automating it. Every step here is what
one n8n node will eventually do, so if a step fails now you have found a real
bug rather than an automation bug — which is the whole point of running it
manually first.

Roughly 30–40 minutes for your first site, most of it waiting on 3D generation.

---

## What you get at the end — and what you do not

The deliverable is **a URL**, not a file you open. Cursor runs the build and the
deploy; nothing needs installing on your machine.

That is worth being firm about, because the obvious-seeming alternative — "just
give me an HTML file I can double-click" — quietly produces a different product.
A file opened from your desktop has no server, so it has no login, no database,
no Stripe, and no encryption; prices end up hardcoded in the markup where a
visitor can edit them before checkout; and there is no asset manifest, so the
Higgsfield step has nothing to swap into. It looks like the site. It is a
picture of the site.

It is also not what a client wants. Nobody buys a website by receiving a zip.
They want a link that works on their phone, and that link is free — Cloudflare
Pages, unlimited bandwidth, deployed by Cursor in one command.

So: **you never install Node.** Cursor has it. If a generation run ever offers
you a static HTML fallback "since you don't have npm", that is the run going
wrong, and the precondition gate in CURSOR-PROMPT.md exists to stop it.

---

## Before you start

```bash
git clone <this-template> test-site && cd test-site
cd backend && npm install && cd ../frontend && npm install && cd ..
```

Accounts needed, all on free tiers: **Cloudflare**, **Turso**, **Supabase**,
**Stripe** (test mode), **Higgsfield**. Cost breakdown at the bottom.

---

## Step 1 — Write the brief

Copy `contracts/brief.example.json` to `brief.json` and edit it for whatever
business you're testing with. Invent one; use a real local business if you want
something to compare against.

The fields that actually change the output:

| Field | Effect |
|---|---|
| `business.one_liner` | Every headline derives from this. Vague in, vague out. |
| `business.differentiator` | The only source of non-generic copy on the page. |
| `design.direction` | Picks one of the six token packs. Whole visual identity. |
| `three_d.subjects[].prompt` | Goes to Higgsfield verbatim. Under ~15 words gets you a generic blob. |
| `three_d.subjects[].key` | Stable id. The frontend looks assets up by this and nothing else. |

Validate before you spend a generation cycle on a broken brief:

```bash
npx --yes ajv-cli validate -s contracts/brief.schema.json -d brief.json
```

---

## Step 2 — Generate with Cursor

Open the repo in Cursor. Add `brief.json`, `README.md`, and `contracts/` to
context, then paste the prompt in `CURSOR-PROMPT.md` (next file over).

**What Fable should touch:** `frontend/src/site.config.ts`, `frontend/index.html`,
`frontend/src/pages/*`, `frontend/src/sections/*`,
`frontend/src/data/assets.manifest.json`, `backend/wrangler.toml`.

**What it must not touch:** `backend/src/middleware/*`, `backend/src/lib/*`,
`backend/src/db/client.ts`, `frontend/src/three/*`, `contracts/*`.

Check that boundary held before moving on:

```bash
git diff --stat backend/src/middleware backend/src/lib frontend/src/three
# Any output here means a security control was edited. Revert it.
```

Then:

```bash
cd frontend && npm run build
```

The site should build and look complete — with primitive placeholder shapes
where the 3D goes. That's correct. Real models arrive in step 4.

---

## Step 3 — Provision infrastructure

```bash
# Turso database for this site
turso db create test-site
turso db show test-site --url          # → TURSO_DATABASE_URL
turso db tokens create test-site       # → TURSO_AUTH_TOKEN
```

Copy `backend/.dev.vars.example` to `backend/.dev.vars` and fill it in. Generate
the two encryption keys — **once per site**, and keep them:

```bash
node -e "console.log('DATA_ENCRYPTION_KEYS=k'+new Date().toISOString().slice(0,7).replace('-','')+':'+require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('BLIND_INDEX_KEY='+require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('base64url'))"
```

Then:

```bash
cd backend
npm run migrate          # applies 0001_init + 0002_security
npm run migrate:status   # should list both as applied
```

Skip domain registration for a test — use the free `*.workers.dev` subdomain.
`scripts/provision.ts` is for when you're doing this for a paying client.

---

## Step 4 — Higgsfield 3D

For each subject in `brief.three_d.subjects[]`, generate a GLB. Build the prompt
the way the pipeline will:

```
{subject.prompt}, {material_hint} material, {direction style}, single isolated
object, centred, neutral background, no ground plane, no text
```

Direction style strings are in `n8n/build-workflows.mjs` under `DIRECTION_STYLE`.
Prompt order matters — Higgsfield weights opening tokens most heavily, so the
subject leads and constraints trail.

Collect the results into `results.json`:

```json
{
  "assets": [
    {
      "key": "hero_subject",
      "status": "ready",
      "source": "higgsfield",
      "url": "https://cdn.higgsfield.ai/....glb",
      "poster": "https://cdn.higgsfield.ai/....jpg",
      "triangles": 84000,
      "higgsfield_job_id": "job_abc123"
    }
  ]
}
```

`key` must match the manifest exactly. `poster` is not optional — it's what a
visitor with no WebGL sees, and without it that section is an empty box.

Apply it:

```bash
cd backend
npm run apply -- --assets ../results.json --manifest ../frontend/src/data/assets.manifest.json
```

This writes to Turso and checks the frontend manifest agrees with the database.
Then rebuild so the frontend picks up the new URLs:

```bash
cd ../frontend && npm run build
```

**Note what did not happen:** no component was edited, no import changed. The
swap is a data change, which is exactly what makes it safe to automate later.

---

## Step 5 — Quality check

```bash
cd frontend && npm run budget
```

Fails the build on: three.js in the entry chunk (collapses the whole lazy-load
architecture), source maps present, placeholder tokens surviving, lorem text,
any key pattern in the bundle, 3D assets with no poster.

Then walk the checklist in `README.md` § *Step-5 quality checklist* — the parts a
script can't judge. Especially: does every string trace back to a brief field, or
did the model invent a statistic?

---

## Step 6 — Deploy and verify

```bash
cd backend
npx tsx scripts/push-secrets.ts --file .dev.vars
npx wrangler deploy

cd ../frontend
npx wrangler pages deploy dist --project-name test-site

cd ../backend
npm run verify -- --origin https://test-site.<you>.workers.dev
```

`verify` asserts security headers are present, `/api/admin/*` returns 401
anonymously, the Stripe webhook rejects an unsigned body, rate limiting engages,
and no secret appears in the client bundle. It ends with a `::result::{...}` line
and exits non-zero on failure.

Manual checks worth doing once, because a script can't:

- Open the site with WebGL disabled (`chrome://flags` → disable WebGL). Posters should render; no empty boxes.
- Turn on `prefers-reduced-motion`. The canvas should stop, not just the CSS.
- Devtools → Sources. You should see mangled names, no comments, **no `.map` files**.
- Request `https://your-site/.env`. You get a plain 404 — and a row in `honeytoken_hits`.
- `GET /api` should return `{"service":"api","status":"ok"}` and nothing more.

---

## Step 7 — Record it

For the manual run, insert the row into Supabase yourself:

```sql
insert into public.sites (account_id, slug, origin, status, assets_ready, assets_total)
values ('<your-test-account-uuid>', 'test-site', 'https://test-site.pages.dev', 'live', 2, 2);
```

Once n8n is wired, workflow 2 does this and gates it on `result.passed`.

---

## Running cost, per site

| Service | Free tier | When you pay |
|---|---|---|
| Cloudflare Workers | 100k requests/day | ~$5/mo past that |
| Cloudflare Pages | Unlimited bandwidth, 500 builds/mo | Rarely |
| Turso | Multiple DBs, generous row reads | Past the free row/storage limits |
| Supabase | 500MB DB, 50k monthly active users | Past that |
| Stripe | No monthly fee | Per transaction only |
| Higgsfield | Credit-based | Per 3D generation — **your main real cost** |
| GitHub Actions | 2,000 min/mo private, unlimited public | Past that |

**Everything in the template runs on free tiers except 3D generation.** No
control in `SECURITY.md` requires a paid plan — MFA, encryption, honeytokens,
audit chaining, rate limiting, and the CI pipeline are all code.

Two things worth knowing before you quote a client:

- **Email is the one gap.** ZeptoMail is cheap but not free. Resend's free tier (~3k/month) is the usual substitute; swap the endpoint in `services/mail.ts` — it's one HTTP call, not a rewrite.
- **Cloudflare's free WAF is real but basic.** Managed rulesets are on paid plans. Turn on what the free tier gives you: Bot Fight Mode, and the free managed ruleset.

Verify these numbers before quoting — provider free tiers change, and I'd rather
you check than quote from a table.
