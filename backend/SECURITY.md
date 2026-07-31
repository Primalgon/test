# Security

What this backend defends against, how, and — the part usually left out — what
it does not defend against.

Controls are mapped to OWASP ASVS 4.0 where there is a clean correspondence.
Every generated site inherits all of it; none of it is per-site configuration,
because a security posture that varies per site is a security posture nobody can
reason about.

---

## Runtime attack surface

The site exposes exactly this and nothing else:

```
public      /healthz /readyz /api/config /api/content/:page /api/assets
            POST /api/contact
            /.well-known/security.txt
auth        /api/auth/*  /api/mfa/*
commerce    /api/products /api/checkout /api/billing-portal
            POST /api/webhooks/stripe          (Stripe signature)
account     /api/account/export  /api/account/erase
admin       /api/admin/*                        (session + role + step-up)
reporting   POST /api/security/csp-report       (browser-originated, 204 always)
```

**There is no build-pipeline endpoint.** An earlier design had HMAC-signed
`/api/_n8n/*` routes so the pipeline could push 3D assets and QA verdicts into a
running site. Those are gone. The build system builds; once a site is deployed,
nothing outside it can write to it except Stripe (signature-verified) and its own
authenticated users.

The reasoning is worth stating because the removed endpoints were not obviously
wrong — they were signed, rate-limited, and validated. But they were a permanent
write path into every production site, existing to serve a need the build already
covers. Assets, content, and QA results are now applied by
`scripts/apply-build-artifacts.ts`, running on the build host before traffic
reaches the deploy. Same outcome, no listening endpoint, and every change has a
git history behind it.

That is the single largest security difference between this template and the
usual generated-site backend.

---

## Controls

### Authentication (ASVS V2)

| Control | Implementation | Why this way |
|---|---|---|
| Password storage | PBKDF2-SHA256, 600k iterations, versioned `v1$iters$salt$hash` | WebCrypto is all Workers offers; bcrypt and argon2 cannot run there. The version prefix makes a later move to argon2id non-breaking. |
| Password policy | Length 12–128, no composition rules | NIST SP 800-63B. Composition rules measurably push people toward `Password1!` and reuse. The 128 ceiling stops a PBKDF2 CPU-exhaustion attack. |
| Breach screening | HIBP k-anonymity range API, threshold 10 | The highest-value password control there is. Credential stuffing is how most takeovers actually happen, and complexity rules do nothing against it. |
| Enumeration | Identical responses and timing on register / login / reset; dummy hash comparison on unknown accounts | Otherwise the login page is a free membership oracle. |
| Lockout | 5 strikes, doubling backoff, capped at 15 min | Capped so lockout cannot be weaponised to deny a real user access indefinitely. |
| MFA | TOTP RFC 6238, secret encrypted at rest, single-use per counter, ±1 step drift | Counter tracking is what makes a code single-use — without it a shoulder-surfed code works for 90 seconds. |
| Recovery | 10 single-use codes, SHA-256, regeneration replaces the whole set | SHA-256 not PBKDF2: these are 80 bits of uniform randomness, so there is no dictionary to slow down. |
| Step-up | Fresh proof within 10 min for irreversible or bulk-data operations | A stolen session otherwise inherits every capability permanently. The list is in `middleware/step-up.ts`. |

### Session management (ASVS V3)

- Opaque 256-bit tokens. Only SHA-256 stored — a database read yields nothing usable.
- **Not JWTs**, deliberately. Revocation is a `DELETE`; a stateless token cannot be withdrawn before it expires, which is exactly what you need during an incident.
- `__Host-` cookie prefix: cannot be set by a subdomain or over http. This matters because every site has an `admin.` subdomain.
- Sliding 12h idle TTL, hard 14-day absolute ceiling.
- CSRF: double-submit token **and** Origin check. `SameSite=Lax` alone still permits top-level POST navigation.
- Session binding — see below.
- No caching of authenticated responses (`no-store` + `Vary: cookie`).

### Session anomaly detection

Graded, and calibrated to be usable rather than maximally strict:

| Signal | Response | Reasoning |
|---|---|---|
| User-agent change (version-normalised) | Revoke | Browsers do not change engine mid-session. Close to a true positive. |
| Country change | Drop step-up elevation, notify owner, keep session | Travellers and VPN users are common; logging them out is how this control gets disabled. |
| IP / ASN change | Record only | Mobile networks rotate IPs constantly. Acting on this is pure noise. |
| New device on account | Email the owner | The notification *is* the control — it is often the first thing that tells someone their password is out. |

Binding hard to IP is the obvious design and is unusable in production: CGNAT,
mobile handoff, corporate egress rotation and VPNs mean it logs out a large
fraction of legitimate users daily.

### Data protection (ASVS V6, V8)

- **Field-level AES-256-GCM** for PII, envelope-encrypted with a versioned keyring. Rotation = prepend a key; old rows keep decrypting.
- **AAD binds ciphertext to its row and column.** Without it, someone with UPDATE access can move an encrypted value between rows — copy the admin's encrypted phone number into their own record — and GCM decrypts it happily.
- **Blind indexes** (keyed HMAC, 128-bit) for exact-match lookup on encrypted columns. Keyed, not plain hash: an unkeyed hash of an email is trivially reversible and leaks the whole column.
- Turso's volume encryption is *not* this control. It protects against a stolen disk. It does nothing against a leaked auth token, a mis-scoped replica, or a dump handed to a contractor — in all of those the attacker is a legitimate client and the volume decrypts for them transparently.
- Masking helpers for anything reaching a log or an admin list view.
- PII redaction in structured logs, recursive by key.
- **No card data ever touches this backend.** Stripe Checkout and the billing portal are hosted; this keeps PCI scope at SAQ-A.

### Access control (ASVS V4)

- Roles: `customer < staff < admin < owner`, checked server-side per route.
- Step-up required for role changes, refunds, PII reveal, MFA changes, erasure, secret rotation.
- Every unmasked PII read is logged with actor and field. An admin reading a hundred addresses leaves a hundred chained entries.
- Column allowlist on the reveal endpoint — parameter binding does not work for identifiers, so an unvalidated field name there would be SQL injection.

### Audit (ASVS V7)

Hash-chained: each entry commits to the previous entry's hash, sequence numbers
contiguous, verified by cron and on demand.

**What this actually buys you:** deletion or edit of any row breaks every hash
after it, so tampering becomes loud instead of silent. It does **not** make
tampering impossible — an attacker with write access can recompute the tail.

That is why `audit_anchors` exists and why the daily cron ships the head
off-site. Once yesterday's head is recorded somewhere the site cannot write to,
history cannot be rewritten without contradicting a copy beyond reach. **An
unanchored chain is a speed bump.** The admin integrity endpoint says so
explicitly rather than reporting a reassuring green tick.

Failed password guesses go to a separate `auth_attempts` table, not the chain —
hashing every brute-force attempt would turn an attacker's effort into your CPU
bill.

### Input and output (ASVS V5)

- Every query parameterised; no string interpolation anywhere in `db/`.
- Zod at every boundary, with explicit maximum lengths.
- Nonce-based CSP, `strict-dynamic`, no `unsafe-inline` for scripts.
- **Trusted Types** — eliminates DOM XSS as a class: assigning a raw string to `innerHTML` throws rather than executing.
- CSP violations reported, aggregated, and visible in the admin dashboard. A policy with no reporting endpoint is one nobody can tell is misconfigured.
- Full modern header set: HSTS 2y + preload, COOP, COEP `credentialless`, CORP, Permissions-Policy, `nosniff`, `frame-ancestors 'none'`.

`COEP: credentialless` rather than `require-corp` is a deliberate compromise:
`require-corp` breaks every third-party asset that does not send CORP headers,
which in practice includes most CDN-hosted GLB and HDRI files. It would take the
3D out on every generated site.

### SSRF (ASVS V12)

All outbound traffic goes through `lib/ssrf.ts`:

- Host **allowlist**, never a blocklist.
- Re-validated after **every redirect** — `redirect: 'manual'`. An allowed host returning a 302 to `169.254.169.254` defeats a check done only on the original URL. This is the most common bypass of a "validated" fetch.
- Rejects credentials in the authority (`https://allowed.com@evil.com/` parses with host `evil.com`), non-standard ports, non-HTTPS.
- Blocks loopback, RFC1918, link-local, and their alternate encodings — decimal, hex, IPv6-mapped.
- Time and byte caps, counted as bytes arrive rather than trusting `Content-Length`.

### Client-side exposure

Devtools cannot be blocked, and no site should pretend otherwise. Everything a
browser renders is already on the visitor's machine. The controls that matter are
about there being nothing worth finding:

- **No source maps.** The single biggest accidental exposure — a map is the original code, and devtools loads it automatically, making minification cosmetic.
- **`drop_console`, `drop_debugger`, top-level mangling, comments stripped.**
- **`GET /api` returns nothing in production.** It used to list every route, which is a free reconnaissance map. Route enumeration is normally the slow part of attacking an unfamiliar API.
- **Generic errors.** No stack, no internal detail, only a request id.
- **No key material in the frontend, ever** — enforced by `npm run budget` and by CI, which scans the built bundle for key patterns, absolute build paths, leftover console calls, and references to internal API surface.
- **Prices resolve server-side** from the `products` table. A price in the client is a price the client can edit.

`frontend/src/lib/protect.ts` provides opt-in copy deterrence for client sites
that want it — right-click and drag on images, copy attribution on long
selections, print suppression. It is documented in the file as **deterrence, not
security**, along with `PROTECTION_DISCLOSURE`, the plain-language text to show
the client so nobody is sold a guarantee that cannot exist.

### Detection — honeytokens

Everything else here tries to keep an attacker out. This assumes they are already
in and asks how you would find out. Median dwell time is measured in weeks,
because in a normal system nothing is *surprising* when touched.

- **Decoy paths** (`/.env`, `/.git/config`, `/wp-admin`) answer with a 404 byte-identical to any other, and log. A distinctive response would tell the scanner it found something.
- **Canary credentials** — an admin account and an API key that exist only in the database and are never issued. Use of one is unambiguous proof the database has been read, and is frequently the *only* signal after a successful data theft.

No false positives, by construction. That is what makes it worth its very small cost.

### Supply chain — CI

`.github/workflows/security.yml` runs on every generated repository:

- `npm ci --ignore-scripts` — the highest-value npm supply-chain control. A malicious postinstall hook runs with full CI permissions before any of your code does; this is how most npm compromises land.
- `npm audit --audit-level=high`, failing rather than warning
- Gitleaks over **full history** — a secret committed then removed is still in the git objects and still valid
- SBOM per build, retained 90 days
- Bundle exposure assertions
- Grep for SQL string interpolation
- **Assertion that the security middleware still exists and still contains its key directives** — a generation run that "simplifies" `ssrf.ts` or drops the `__Host-` prefix has removed a control from a client's live site, and nothing else would catch it

### Rate limiting

Durable Object, not KV. **KV is eventually consistent across colos**, so a
KV-backed limit can be exceeded by roughly the number of edge locations an
attacker can reach — which is all of them.

Per-bucket, per-route. Fails open with a loud log: a rate limiter outage should
not take the site down.

### Availability and incident response

- **Break-glass lockdown**: read-only, not offline. Public pages keep serving; all writes and logins refuse; every session but the declaring owner's is revoked.
- Read-only rather than dark on purpose — taking the site down tells the attacker they were spotted, costs the client every visitor, and destroys the live signal about what they were reaching for.
- Cached 5s in KV so the check does not put a query in front of the homepage.
- `/api/admin/security/posture` — continuous self-assessment: admins without MFA, encryption unconfigured, stale sessions, authentication failure spikes.

---

## Deliberate trade-offs

Each of these is a place where the maximally secure option was rejected. If you
disagree with one, change it knowingly.

1. **Breach check fails open.** An HIBP outage would otherwise block every signup and password reset on every site you have generated. It is a strong filter, not an authentication boundary; hashing, lockout, and MFA all remain. Recorded as `checked: false` so the gap is visible.
2. **Rate limiter fails open.** Same reasoning, logged loudly.
3. **Lockdown fails open** on a KV or database error. It is an incident-response tool with a human watching, not an unattended boundary.
4. **IP changes are not acted on.** Explained above — the strict version is unusable.
5. **`style-src 'unsafe-inline'`.** Tailwind's injected layer requires it. Scripts do not get it, and CSS injection without script execution is a far smaller problem.
6. **PBKDF2 rather than argon2id.** Not a choice — Workers has no memory-hard KDF. 600k iterations is the OWASP compensation. The stored format is versioned for the day this moves to a Node runtime.
7. **TOTP, not WebAuthn.** WebAuthn is strictly better and phishing-resistant, and is the right next addition. TOTP works everywhere today with no hardware requirement.
8. **Erasure anonymises rather than deletes.** Article 17(3) preserves data required by law; tax rules require transaction records for six to ten years. Personal identifiers go, financial records stay, the link is severed.

---

## Not covered — know these before you sell against them

- **WebAuthn / passkeys.** The most valuable single addition available. TOTP is phishable; passkeys are not.
- **Formal pen test.** Nothing here substitutes for one. `scripts/verify-deployment.ts` asserts the controls are *present*; it does not attempt to defeat them.
- **DDoS above Cloudflare's free tier.** Volumetric defence is Cloudflare's layer, not this one.
- **Supply chain.** Now covered by CI (audit, SBOM, `--ignore-scripts`, gitleaks). Dependencies are still not vendored.
- **Backups.** Turso point-in-time recovery is a platform setting and is not configured here. **Configure it.** An unrecoverable database beats every control on this page for total damage caused.
- **Secret rotation cadence.** Supported (`SESSION_SECRET_PREVIOUS`, versioned keyring) but not scheduled or enforced.
- **Insider threat above `owner`.** Whoever holds the Cloudflare account can read and change anything. No application-layer control reaches that.

---

## Reporting

`security@<site-domain>`, or the address in `SECURITY_CONTACT`. Served at
`/.well-known/security.txt` per RFC 9116 — the cheapest control on this page, and
the reason a researcher sends you a finding instead of posting it.
