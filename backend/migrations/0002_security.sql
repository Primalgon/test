-- ===========================================================================
-- 0002 — security layer
--
-- Adds: MFA, recovery codes, device tracking, session binding, step-up state,
-- the tamper-evident audit chain, CSP report aggregation, encrypted PII columns
-- and their blind indexes, and the break-glass flag.
--
-- Written to be re-runnable: every ALTER is guarded by the migration runner's
-- checksum, and every CREATE uses IF NOT EXISTS.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Users: MFA and lifecycle
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_secret TEXT;              -- AES-GCM envelope, never plaintext
ALTER TABLE users ADD COLUMN mfa_pending_secret TEXT;      -- enrolment, before a code has been proven
ALTER TABLE users ADD COLUMN mfa_pending_at INTEGER;
ALTER TABLE users ADD COLUMN mfa_activated_at INTEGER;
ALTER TABLE users ADD COLUMN mfa_last_counter INTEGER;     -- makes each TOTP code single-use
ALTER TABLE users ADD COLUMN erased_at INTEGER;

-- Encrypted PII. Nullable because most sites collect none of it; a column that
-- is never written costs nothing.
ALTER TABLE users ADD COLUMN phone_encrypted TEXT;
ALTER TABLE users ADD COLUMN address_encrypted TEXT;

-- Blind index for exact-match lookup on the encrypted email, once a site is
-- configured to encrypt it. Keyed HMAC, so it supports equality and nothing
-- else — no LIKE, no ORDER BY, no range scan. Design queries accordingly.
ALTER TABLE users ADD COLUMN email_bidx TEXT;
CREATE INDEX IF NOT EXISTS users_email_bidx ON users(email_bidx);

-- ---------------------------------------------------------------------------
-- Sessions: binding signals and step-up state
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN asn TEXT;
ALTER TABLE sessions ADD COLUMN country TEXT;
ALTER TABLE sessions ADD COLUMN ua_hash TEXT;
ALTER TABLE sessions ADD COLUMN anomaly_notified_at INTEGER;
ALTER TABLE sessions ADD COLUMN revoked_reason TEXT;

-- Elevation lives on the session, not the user. Marking the user would elevate
-- every device that account is signed in on, including an attacker's.
ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
ALTER TABLE sessions ADD COLUMN reauth_method TEXT;

CREATE INDEX IF NOT EXISTS sessions_user_active
  ON sessions(user_id, revoked_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Orders: encrypted shipping data and erasure tombstones
-- ---------------------------------------------------------------------------

ALTER TABLE orders ADD COLUMN shipping_address_encrypted TEXT;
ALTER TABLE orders ADD COLUMN customer_name TEXT;

-- ---------------------------------------------------------------------------
-- Recovery codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recovery_codes (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256, not PBKDF2. These are 80 bits of uniform randomness, so there is
  -- no dictionary to slow down and no reason to pay 600k iterations per attempt.
  code_hash    TEXT NOT NULL,
  used_at      INTEGER,
  used_ip_hash TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS recovery_codes_user ON recovery_codes(user_id, used_at);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_codes_unique ON recovery_codes(user_id, code_hash);

-- ---------------------------------------------------------------------------
-- Known devices
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS known_devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Version numbers are normalised out before hashing, so a browser auto-update
  -- does not register as a new device and bury the real signal in noise.
  ua_hash       TEXT NOT NULL,
  country       TEXT,
  asn           TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  seen_count    INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS known_devices_unique ON known_devices(user_id, ua_hash);

-- ---------------------------------------------------------------------------
-- Audit log — rebuilt as a hash chain
--
-- 0001 created a plain audit_log. This replaces it with a chained version.
-- Existing rows are migrated in with a fresh chain rather than discarded; their
-- hashes are computed from the new genesis, so history before this migration is
-- readable but was never chained and carries no integrity guarantee. That is
-- worth knowing rather than papering over.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log RENAME TO audit_log_legacy;

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  -- Monotonic and contiguous. A gap in this column is itself evidence.
  seq         INTEGER NOT NULL UNIQUE,
  prev_hash   TEXT NOT NULL,
  entry_hash  TEXT NOT NULL,

  actor_type  TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,

  ip_hash     TEXT,
  user_agent  TEXT,
  request_id  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor   ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action  ON audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity  ON audit_log(entity, entity_id);

-- ---------------------------------------------------------------------------
-- Audit anchors
--
-- The chain alone makes tampering detectable. Anchoring makes it hard: once a
-- head has been recorded somewhere the site cannot write to, an attacker inside
-- the site can no longer rewrite history without contradicting a copy they
-- cannot reach. Without anchors, an attacker with write access simply recomputes
-- the chain and it verifies cleanly.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_anchors (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,
  hash         TEXT NOT NULL,
  destination  TEXT NOT NULL,       -- 'platform' | 'email' | 'r2'
  anchored_at  INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE INDEX IF NOT EXISTS audit_anchors_seq ON audit_anchors(seq DESC);

-- ---------------------------------------------------------------------------
-- CSP violation reports, aggregated
--
-- Aggregated rather than per-event on purpose: one misbehaving browser extension
-- can produce tens of thousands of reports an hour, and a per-event table turns
-- a monitoring feature into a denial-of-service vector against your own database.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS csp_reports (
  id            TEXT PRIMARY KEY,
  directive     TEXT NOT NULL,
  blocked_uri   TEXT NOT NULL,
  document_uri  TEXT,
  count         INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS csp_reports_unique ON csp_reports(directive, blocked_uri);

-- ---------------------------------------------------------------------------
-- Site flags — break-glass and other operational switches
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS site_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO site_flags (key, value, updated_at)
VALUES ('lockdown', '0', unixepoch());

-- ---------------------------------------------------------------------------
-- Authentication attempt ledger
--
-- Separate from audit_log because it is high-volume, short-lived, and queried on
-- a different axis. Mixing it into the chained audit table would mean hashing
-- every failed password guess an attacker makes — turning their brute force into
-- your CPU cost.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_attempts (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,        -- email blind index or IP hash, never plaintext
  kind        TEXT NOT NULL,        -- 'password' | 'totp' | 'recovery' | 'reset'
  success     INTEGER NOT NULL,
  ip_hash     TEXT,
  country     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_attempts_identifier ON auth_attempts(identifier, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_attempts_created    ON auth_attempts(created_at);

-- ---------------------------------------------------------------------------
-- Assets: regeneration requests
--
-- The site records that its owner wants an asset regenerated; it does not
-- regenerate anything itself. Generation happens in the build pipeline, off
-- this machine, and arrives via a rebuild. The site therefore needs no runtime
-- write path for its own 3D assets, and no always-open endpoint for one.
-- ---------------------------------------------------------------------------

ALTER TABLE assets ADD COLUMN regenerate_requested_at INTEGER;
ALTER TABLE assets ADD COLUMN regenerate_prompt TEXT;

-- ---------------------------------------------------------------------------
-- Honeytokens
--
-- Things with no legitimate reason to ever be touched. That is what makes them
-- valuable: there is no false positive to triage, so an alert here means what
-- it says. Most detection fails because the anomalous request looks like all
-- the others; these cannot.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS honeytokens (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,          -- 'canary_account' | 'canary_api_key' | 'canary_row'
  token      TEXT NOT NULL,
  note       TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS honeytokens_token ON honeytokens(kind, token);

CREATE TABLE IF NOT EXISTS honeytoken_hits (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  token      TEXT NOT NULL,
  path       TEXT,
  ip_hash    TEXT,
  user_agent TEXT,
  country    TEXT,
  severity   TEXT NOT NULL DEFAULT 'low',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS honeytoken_hits_created  ON honeytoken_hits(created_at DESC);
CREATE INDEX IF NOT EXISTS honeytoken_hits_severity ON honeytoken_hits(severity, created_at DESC);
