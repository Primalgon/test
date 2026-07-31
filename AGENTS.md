# Agent instructions

# Forge — generation rules

This repository is a production website template. Sites generated from it are
deployed for paying clients.

## This is an EDIT task, never a BUILD task

The site already exists. React + Vite + React Three Fiber, with a Hono/Cloudflare
Workers backend. Fill it in from `brief.json`. Do not choose a framework, do not
create a build setup, do not start from scratch.

**Never create a standalone `.html` file.** Not as a preview, not as a simpler
version, not because the user may lack Node. You run the build; they do not need
it. A static file has no server, so it has no login, no database, no Stripe, and
no encryption — and the asset manifest the Higgsfield step writes into does not
exist. This has already happened once and produced a non-functional site.

**Never add an external origin** — no Google Fonts, no cdnjs, no unpkg. The
production CSP is nonce-based and blocks them: the page renders unstyled and the
3D never loads. Fonts are self-hosted from `/fonts`.

## Do not modify

    backend/src/middleware/*   auth, CSP, rate limiting, lockdown, honeytokens
    backend/src/lib/*          crypto, TOTP, encryption, SSRF guard, audit chain
    backend/src/db/client.ts
    frontend/src/three/*       the 3D quality gate and manifest indirection
    contracts/*                the interfaces between pipeline stages

If one of these looks over-engineered, it is deliberate. `backend/SECURITY.md`
explains each decision. Editing them removes a security control from a live
client site.

## Edit only

    frontend/src/site.config.ts
    frontend/index.html
    frontend/src/pages/*
    frontend/src/sections/*
    frontend/src/data/assets.manifest.json
    frontend/src/styles/directions.css
    backend/wrangler.toml

## Read the industry preset first

`brief.business.industry` names an entry in `contracts/industry-presets.ts`. It
specifies the sections, the commerce model, the 3D subjects, and whether the site
needs user accounts. Follow it rather than deciding for yourself — that judgement
drifts between runs, which is why the presets exist.

**If the preset says auth is required, the site is not finished without login,
signup, and account pages.** For those verticals the account is the product; a
version without it is non-functional, not simpler. The backend routes already
exist and are already secured — wire a UI to them, never reimplement session or
password handling.

## Never

- Invent statistics, testimonials, client names, years in business, hours, or addresses. Every string traces to a `brief.json` field.
- Hardcode a price anywhere in the frontend. Prices come from `useProducts()` in `lib/commerce.ts`, resolved server-side.
- Fabricate a 3D model URL. Assets start as `placeholder`/`primitive`; real GLBs arrive from Higgsfield later.
- Import three.js in a section. Use `getAsset()` and the existing `<ThreeStage>`.
- Put a key, token, or connection string under `frontend/`. The bundle is public.

## Before reporting finished

    cd frontend && npm run selfcheck

Exit code 1 means blockers remain. Fix and re-run until it exits 0. Do not
report the site as complete while any blocker stands.
