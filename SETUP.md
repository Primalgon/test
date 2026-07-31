# Setup — repo to deployed site

Start to finish. Do this once to set the repo up, then steps 4 onward for each
client.

---

## What goes in the repo

Everything. All 128 files, exactly as they are.

```
forge/
├── .cursor/rules/forge.mdc   ← Cursor reads this automatically, every session
├── AGENTS.md                 ← same rules, for tools that read this instead
├── .gitignore                ← keeps keys out of commits. Never delete.
├── .github/workflows/        ← security CI on every push
├── contracts/                ← brief schema + 112 industry presets
├── backend/                  ← Hono API, auth, commerce, security, migrations
├── frontend/                 ← React + Vite + R3F, 15 sections
├── n8n/                      ← platform automation (later)
├── README.md
├── MANUAL-RUN.md
├── CURSOR-PROMPT.md
└── SETUP.md                  ← this file
```

The one that changes how Cursor behaves is `.cursor/rules/forge.mdc`. Cursor
loads it on every request in this repo, so the do-not-touch list and the
never-build-a-static-site rule apply whether or not you remember to paste
anything. `AGENTS.md` carries the same content for other tools.

**Do not add `.dev.vars` to the repo.** `.gitignore` blocks it, and that block is
the most important line in this project — that file holds the key to every
encrypted column in a client's database. A secret committed and later deleted is
still in the git objects and still valid until rotated; deleting it in a later
commit does nothing.

---

## 1. Create the repo

```bash
unzip forge-templates.zip && cd forge
git init
git add .
git commit -m "Forge template"
```

Then on GitHub: **New repository**, name it `forge` (or whatever you like),
**Private**, and do not tick any of the "add a README / .gitignore / license"
boxes — the repo already has them and ticking them causes a merge conflict on
your first push.

```bash
git remote add origin https://github.com/YOUR-USERNAME/forge.git
git branch -M main
git push -u origin main
```

Confirm `.dev.vars` is not up there. It should not be, but check once:

```bash
git ls-files | grep dev.vars
```

Only `.dev.vars.example` should appear. If anything else does, stop and tell me.

---

## 2. Open in Cursor

**File → Open Folder →** the `forge` folder. The folder, not the zip, not
individual files.

Verify Cursor can see the template:

```bash
ls frontend/src/site.config.ts frontend/src/data/assets.manifest.json \
   frontend/src/three backend/src/middleware backend/wrangler.toml
```

Five paths, five results. Any "No such file" and nothing else will work —
that is the state that makes a model invent a site from scratch.

---

## 3. One-time install

```bash
cd backend && npm install
cd ../frontend && npm install
```

Bare `npm install`; the `.npmrc` handles the peer-dependency flag.

---

## 4. Write the brief — per client

```bash
cp contracts/brief.example.json brief.json
```

Fill it in. The field that does the most work is `business.industry` — it must
be one of the 112 ids in `contracts/industry-presets.ts`, and it selects the
sections, the commerce model, the 3D subjects, and whether the site gets user
accounts.

Find the right one:

```bash
grep -o 'id: "[a-z_]*", label: "[^"]*"' contracts/industry-presets.ts
```

Validate before spending a generation run on a broken brief:

```bash
npx -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft2020 -c ajv-formats \
  -s contracts/brief.schema.json -d brief.json
```

---

## 5. Generate

In Cursor's chat, attach `brief.json`, then paste the prompt block from
`CURSOR-PROMPT.md`.

The rules in `.cursor/rules/forge.mdc` are already active, so the prompt is
reinforcing them rather than introducing them. Paste it anyway — the per-run task
description lives there.

---

## 6. Verify — the step that catches everything

```bash
cd frontend && npm run selfcheck
```

25+ checks. Exit code 1 means blockers remain. Open `selfcheck-report.html` for
the readable version, fix what is red, run it again. Repeat until it exits 0.

Do not accept "the site is finished" while any blocker stands. This script exists
because a generation run cannot see its own gaps — from the inside, the output
always looks complete.

Two failures are expected before Higgsfield has run: assets without posters, and
placeholders not yet upgraded. Everything else is a real problem.

---

## 7. 3D — Higgsfield

Generate a GLB for each subject the preset named. Prompt shape:

```
{subject}, {material} material, {direction style}, single isolated object,
centred, neutral background, no ground plane, no text
```

Collect into `results.json` — `key` must match the manifest exactly, `poster` is
not optional (it is what a visitor without WebGL sees):

```json
{ "assets": [ {
  "key": "hero_subject", "status": "ready", "source": "higgsfield",
  "url": "https://cdn.higgsfield.ai/....glb",
  "poster": "https://cdn.higgsfield.ai/....jpg",
  "triangles": 84000, "higgsfield_job_id": "job_abc"
} ] }
```

```bash
cd backend && npm run apply -- --assets ../results.json \
  --manifest ../frontend/src/data/assets.manifest.json
cd ../frontend && npm run build && npm run selfcheck
```

No component or import changed — the swap is a data change. That is what makes
it safe to automate later.

---

## 8. Database — once per client site

```bash
turso db create CLIENT-NAME
turso db show CLIENT-NAME --url        # → TURSO_DATABASE_URL
turso db tokens create CLIENT-NAME     # → TURSO_AUTH_TOKEN
```

```bash
cp backend/.dev.vars.example backend/.dev.vars
```

Generate the keys — **once per site, and keep them.** Losing
`DATA_ENCRYPTION_KEYS` means losing every encrypted column in that client's
database, permanently. There is no recovery path; that is what encryption at rest
means.

```bash
node -e "console.log('DATA_ENCRYPTION_KEYS=k'+new Date().toISOString().slice(0,7).replace('-','')+':'+require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('BLIND_INDEX_KEY='+require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('base64url'))"
```

Paste all three into `backend/.dev.vars`, then:

```bash
cd backend && npm run migrate && npm run migrate:status
```

Both migrations should read `Applied`.

---

## 9. Deploy

```bash
cd backend
npx wrangler login          # first time only
npx tsx scripts/push-secrets.ts --file .dev.vars
npx wrangler deploy

cd ../frontend
npx wrangler pages deploy dist --project-name CLIENT-NAME

cd ../backend
npm run verify -- --origin https://CLIENT-NAME.YOUR-SUBDOMAIN.workers.dev
```

`verify` asserts the security headers are present, `/api/admin/*` returns 401
anonymously, the Stripe webhook rejects an unsigned body, rate limiting engages,
and no secret is in the client bundle.

**The Pages URL is the deliverable.** Send the client a link, not a zip.

---

## Per-client, after the one-time setup

```
brief.json → Cursor → npm run selfcheck → Higgsfield → npm run apply
           → selfcheck again → migrate → deploy → verify → send URL
```

Branch per client so `main` stays a clean template:

```bash
git checkout -b client/crust-fire
```

---

## If something goes wrong

| Symptom | Cause |
|---|---|
| Cursor creates `.html` files | It cannot see the template. Re-run step 2. |
| `selfcheck`: no login page | Preset requires auth and it was skipped. Point Cursor at the Auth blockers. |
| `selfcheck`: external origins | Google Fonts or a CDN crept in. The CSP blocks these. |
| `npm install` fails | Run it inside `backend/` or `frontend/`, not the root. |
| `wrangler deploy`: not authenticated | `npx wrangler login` |
| 3D never appears | Check `assets.manifest.json` — status must be `ready` with a real URL. |
