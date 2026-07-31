-- ---------------------------------------------------------------------------
-- 0001_init — per-site Turso database.
-- One Turso database per generated site. Your own platform data (orders,
-- briefs, which customer owns which site) stays in Supabase and is never
-- mixed in here: a site's DB must be safe to hand over to the client.
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- --- end users of the generated site --------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  email_canonical TEXT NOT NULL,          -- lowercased + trimmed; uniqueness lives here
  email_verified  INTEGER NOT NULL DEFAULT 0,
  password_hash   TEXT,                   -- NULL for passwordless / OAuth-only accounts
  name            TEXT,
  role            TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff','admin','owner')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  stripe_customer_id TEXT,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,                -- unix seconds; set by progressive lockout
  last_login_at   INTEGER,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_canonical);
CREATE INDEX IF NOT EXISTS idx_users_stripe ON users(stripe_customer_id);

-- --- sessions: opaque server-side tokens, not JWTs -------------------------
-- Only the SHA-256 of the token is stored, so a database leak does not hand
-- an attacker live sessions. Revocation is a DELETE, which a JWT cannot do.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_hash    TEXT NOT NULL,
  ip_hash      TEXT,                      -- hashed, never the raw IP
  user_agent   TEXT,
  expires_at   INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,   -- hard ceiling; sliding renewal cannot pass it
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS verification_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset','magic_link','email_change')),
  token_hash TEXT NOT NULL UNIQUE,
  payload    TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vtokens_user ON verification_tokens(user_id, purpose);

-- --- catalog + commerce ----------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency      TEXT NOT NULL DEFAULT 'usd',
  recurring     TEXT NOT NULL DEFAULT 'none' CHECK (recurring IN ('none','month','year')),
  stripe_price_id   TEXT,
  stripe_product_id TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  inventory     INTEGER,                  -- NULL = unlimited
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT REFERENCES users(id) ON DELETE SET NULL,
  email               TEXT NOT NULL,      -- guest checkout keeps working without a user row
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','paid','fulfilled','refunded','partially_refunded','cancelled','failed')),
  amount_cents        INTEGER NOT NULL,
  amount_refunded_cents INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'usd',
  stripe_session_id       TEXT UNIQUE,
  stripe_payment_intent   TEXT,
  stripe_subscription_id  TEXT,
  items               TEXT NOT NULL DEFAULT '[]',
  shipping            TEXT,
  notes               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_pi ON orders(stripe_payment_intent);

-- Stripe delivers webhooks at-least-once. This table is the idempotency guard:
-- the INSERT is what claims an event, so concurrent deliveries cannot both win.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,          -- provider event id, e.g. evt_123
  provider     TEXT NOT NULL,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','done','failed')),
  attempts     INTEGER NOT NULL DEFAULT 1,
  last_error   TEXT,
  payload_hash TEXT,
  received_at  INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events(status, received_at DESC);

-- --- site content ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_blocks (
  id          TEXT PRIMARY KEY,
  page_slug   TEXT NOT NULL,
  block_key   TEXT NOT NULL,
  locale      TEXT NOT NULL DEFAULT 'en-US',
  value       TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_unique ON content_blocks(page_slug, block_key, locale);

CREATE TABLE IF NOT EXISTS submissions (
  id           TEXT PRIMARY KEY,
  form_key     TEXT NOT NULL,
  payload      TEXT NOT NULL,
  email        TEXT,
  ip_hash      TEXT,
  user_agent   TEXT,
  spam_score   REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','archived','spam')),
  forwarded_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at DESC);

-- --- 3D asset registry -----------------------------------------------------
-- Mirrors frontend/src/data/assets.manifest.json so the running site can report
-- what it is actually serving, and so a re-generation can be triggered from the
-- admin dashboard without touching the repo.
CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,
  asset_key      TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'placeholder' CHECK (status IN ('placeholder','generating','ready','failed')),
  source         TEXT NOT NULL DEFAULT 'primitive' CHECK (source IN ('primitive','higgsfield','client_supplied')),
  url            TEXT,
  poster_url     TEXT,
  bytes          INTEGER,
  triangles      INTEGER,
  higgsfield_job_id TEXT,
  prompt         TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  updated_at     INTEGER NOT NULL
);

-- --- security + operations -------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  actor_type  TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system','webhook','n8n')),
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  ip_hash     TEXT,
  before_json TEXT,
  after_json  TEXT,
  request_id  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  response_json TEXT,
  status       TEXT NOT NULL DEFAULT 'in_flight' CHECK (status IN ('in_flight','done')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id           TEXT PRIMARY KEY,
  destination  TEXT NOT NULL CHECK (destination IN ('n8n','platform','crm','mail')),
  event_type   TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  sent_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, next_retry_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum   TEXT NOT NULL
);
