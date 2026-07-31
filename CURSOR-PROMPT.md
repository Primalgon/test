# The Cursor prompt

## First: open the folder, not the documents

**File → Open Folder → the unzipped `forge` folder.** Not the zip, not four `.md`
files.

This one step decides whether the run works. A model handed a spec with no
codebase will build a plausible standalone demo from scratch every time, because
that is the only thing it can do. It will look finished. It will have no backend,
no asset manifest, and no way for the Higgsfield step to ever run. The failure is
silent and it looks like success.

Confirm the template is actually there:

```bash
ls frontend/src/site.config.ts frontend/src/data/assets.manifest.json \
   frontend/src/three backend/src/middleware backend/wrangler.toml
```

Five paths, five results. Any "No such file" and nothing below will work.

Add to context: `brief.json`, `README.md`, `backend/SECURITY.md`, `contracts/`,
`frontend/src/site.config.ts`, `frontend/src/data/assets.manifest.json`,
`frontend/src/lib/manifest.ts`.

Those last three matter more than the documentation. They are the files the model
is meant to *edit*, and having them open is what keeps it editing rather than
inventing.

---

```
You are generating a production website from a client brief and an EXISTING
hardened template. Both are in context. This site will be deployed for a paying
client. Treat it as production work.

## STOP — precondition check, before anything else

Run:

  ls frontend/src/site.config.ts frontend/src/data/assets.manifest.json \
     frontend/src/three backend/src/middleware backend/wrangler.toml

If ANY path is missing, STOP and reply exactly:

  "TEMPLATE NOT IN CONTEXT — cannot proceed. Missing: <paths>."

Do not build a site from scratch. Do not create standalone .html files. Do not
work around the missing files. The template IS the product — a site built
without it has no backend, no security, and no asset manifest, and it fails
every downstream stage. An honest stop costs ten minutes. A from-scratch site
that looks finished costs a day, and nothing about it will look wrong.

## This is an EDIT task, not a BUILD task

The site already exists. Fill it in from the brief. The framework is chosen
(React + Vite + React Three Fiber). The backend exists. The design system exists.

Forbidden, without exception:
  - Creating any .html file other than editing frontend/index.html
  - Adding a CDN <script> or <link> tag to any external origin
  - Introducing a framework, bundler, or build setup
  - Building a "simpler static version" for any reason, including if you believe
    the user cannot run Node. They do not need to; you run the build.

## Do not modify — security-critical, identical across every site

  backend/src/middleware/*   auth, CSP, rate limiting, lockdown, honeytokens
  backend/src/lib/*          crypto, TOTP, encryption, SSRF guard, audit chain
  backend/src/db/client.ts   the @libsql/client/web import is load-bearing
  backend/src/routes/*       except where a brief field genuinely requires it
  frontend/src/three/*       the quality gate and manifest indirection
  contracts/*                the interfaces between pipeline stages

If any of these looks over-engineered, it is deliberate. SECURITY.md explains
each decision. A change here removes a control from a live client site.

## Edit ONLY these

  frontend/src/site.config.ts             every field, from the brief
  frontend/index.html                     title, description, OG tags, JSON-LD
  frontend/src/pages/*                    one page per brief.site.pages[]
  frontend/src/sections/*                 compose from each page's sections[]
  frontend/src/data/assets.manifest.json  one entry per three_d.subjects[]
  frontend/src/styles/directions.css      only to ADD a direction block
  backend/wrangler.toml                   name, routes, [vars]

## Read the industry preset FIRST

brief.business.industry names an entry in contracts/industry-presets.ts. Open
that entry before writing anything. It tells you:

  - sections   the exact sections for this vertical, in page order
  - commerce   one_time | subscription | booking | quote | none
  - auth       required | optional | none
  - subjects   which 3D assets to put in the manifest
  - note       the trap specific to that trade

Follow it. Do not substitute your own judgement about what a business "probably"
needs — the preset exists because that judgement drifts between runs.

## If the preset says auth is required, the site is NOT done without it

This is the failure that has actually happened, so it is worth stating plainly.
A streaming service, a gym, a hotel, a clinic — these are not brochures with a
payment button bolted on. The account IS the product. A version without login,
signup, account pages, and billing is not a simpler version of that site, it is
a non-functional one.

When auth is required you must wire, in frontend/src/pages/:

  - a login page and a signup page against the existing /api/auth routes
  - an account page showing the user's own orders or subscription
  - a header state that reflects whether someone is signed in
  - for commerce: subscription, a link to the Stripe billing portal
  - for commerce: booking, a page listing the user's bookings

The backend routes for all of this already exist and are already secured. You
are wiring a UI to endpoints that work, not building auth. Do not write your own
session handling, your own password logic, or your own token storage — that code
exists in backend/src/middleware and it is on the do-not-touch list for a reason.

## Rules

1. Every string traces back to a brief.json field. Invent no statistics,
   testimonials, client names, years in business, awards, hours, or addresses.
   If the brief does not support a claim, do not make it — this is legal
   exposure for the client, and it is the most common failure in this task.

2. Use ONLY the CSS custom properties from brief.design.direction's block. Never
   a hex colour, font family, or pixel value in a component. The direction pack
   controls palette, type scale, spatial rhythm, AND 3D lighting — that last
   part is why models look art-directed rather than pasted on.

3. Fonts are self-hosted and already wired. No Google Fonts, no cdnjs, no
   external origin. The production CSP is nonce-based and blocks all of them:
   the page renders unstyled and the 3D does not load. This is not a style
   preference, the site visibly breaks.

4. Every 3D asset starts status "placeholder", source "primitive". Never invent
   a model URL. Real GLBs arrive from Higgsfield later via a build script. Every
   asset needs an `alt` string and a `poster` field (null for now).

5. Reach 3D only through getAsset('key') from lib/manifest.ts, and render only
   through the existing <Scene> / <ModelSlot>. Never import three.js in a
   section. That indirection is what makes the Higgsfield swap a data change
   instead of a code edit — without it, step 4 of the pipeline cannot run.

6. three.js must never reach the entry chunk. It loads behind the existing lazy
   gate — capability check, IntersectionObserver, requestIdleCallback. The gate
   is written. Use it; do not reimplement it.

7. No secrets under frontend/. No keys, tokens, or connection strings, not even
   in a comment. The bundle is public.

8. Prices are NEVER in the frontend — not in JSX, not in a constant, not in the
   manifest. They resolve server-side from the products table via the existing
   commerce hook. A price in the client is a price the client edits in devtools
   before checkout.

9. In Hero3D the 3D and headline share a grid, they do not stack. Stacked, the
   model reads as decoration rather than as the subject.

10. Real copy only. No lorem ipsum, no "Coming soon", no TODO, no surviving
    placeholder tokens.

11. If a brief field has no supporting data (hours with no address, a specials
    carousel with no specials), do NOT fill the gap with invention and do NOT
    silently drop the section. Render it with only what the brief supports, and
    list it in your report under "brief too thin".

## Accessibility, non-negotiable

  One <h1> per page, headings not skipped. Alt text on every image. role="img"
  and aria-label on every canvas. Keyboard reaches every control, focus always
  visible. Body text at least 4.5:1 contrast.

## Then build, verify, and DEPLOY A PREVIEW

  cd frontend && npm install && npm run typecheck && npm run build && npm run budget
  cd ../backend && npm install && npm run typecheck
  git diff --stat backend/src/middleware backend/src/lib frontend/src/three
  git status --porcelain

Command 3 must print nothing — anything means you edited a protected file.
Command 4 must show ONLY files from the allowed list. A new .html file, a new
config, anything outside that list means you built instead of edited. Revert.

`npm run budget` will fail on missing posters until Higgsfield has run. That
specific failure is expected at this stage. Every other failure is a blocker.

## Self-review — run this and fix every blocker before you report back

  cd frontend && npm run selfcheck

It independently reads the files and checks 25+ requirements: that you edited
the template rather than replacing it, that no stray .html files exist, that the
security boundary held, that every section the industry preset requires is
rendered, that login/signup/account pages exist when the preset needs them, that
the asset manifest can feed the Higgsfield step, that no price is hardcoded, and
that nothing references an external origin the CSP will block.

Exit code 1 means blockers remain. Fix them and run it again. Repeat until it
exits 0. Do not report the site as finished while any blocker stands — the whole
reason this script exists is that a run reviewing its own work cannot see these
failures, because from the inside the output always looks complete.

It writes selfcheck-report.html, a single self-contained file. Include it in
what you hand back.

Finally, deploy a preview and give me the URL:

  cd frontend && npx wrangler pages deploy dist --project-name <brief.site.domain-slug>-preview

The URL is the deliverable. Do not hand back a zip, a local file path, or
instructions to install anything.

## Report back

  - Output of the precondition check
  - The preview URL
  - Which industry preset you used, and confirmation that every section it lists
    is present
  - If the preset required auth: the URLs of the login, signup, and account
    pages you built
  - The final selfcheck line: ::result::{"passed":true,...}. If passed is false,
    you are not finished.
  - Which brief field drove each page headline
  - Which direction, and one sentence on why it suits this business
  - "Brief too thin": every section you could not fully populate, and the exact
    field that was missing
  - Anything you were tempted to invent
