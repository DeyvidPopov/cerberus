# Database Schema Reference — Project Cerberus

**Authoritative, generated from the actual migrations in `migrations/` (0001–0005), not from memory.**
This document describes the *effective* PostgreSQL schema after every forward-only migration has been
applied in filename order by [`migrate.ts`](../migrations/migrate.ts). It is read-only documentation;
no schema was modified to produce it.

- **Engine:** PostgreSQL, extension `pgcrypto` (for `gen_random_uuid()`).
- **Privacy / security context:** the server stores only ciphertext, hashes, and non-secret
  telemetry. No master password, derived key, plaintext credential, or raw behavioral capture is
  ever stored (PROJECT.md §5, ADR-0001, ADR-0002). Risk thresholds and policy bands live in
  application config, **not** in the schema.

---

## 1. Migration inventory

Applied in lexical filename order, each in its own transaction; applied filenames are recorded in
`schema_migrations` so re-runs are idempotent (forward-only, never edited after running anywhere).

| # | File | Milestone / ADR | Effect on schema |
|---|------|-----------------|------------------|
| 0001 | `0001_initial_schema.sql` | Initial | Creates `pgcrypto`; all 10 base tables (`users`, `vault_keys`, `vault_items`, `devices`, `behavioral_baselines`, `enrollment_samples`, `risk_events`, `sessions`, `totp_secrets`, `step_up_challenges`) and their initial indexes/constraints. |
| 0002 | `0002_enrollment_feature_schema_version.sql` | M6, ADR-0009 | `enrollment_samples` gains `feature_schema_version INTEGER NOT NULL DEFAULT 1`. |
| 0003 | `0003_contextual_signals.sql` | M8, ADR-0011 | `risk_events.composite_score`, `.policy_band`, `.action_taken` made **NULLABLE**; `sessions` gains `is_new_device`; creates `login_failures` table (+2 indexes). |
| 0004 | `0004_step_up_auth.sql` | M9, ADR-0012 | `totp_secrets` gains `last_used_step`; `step_up_challenges` gains `token_hash`, `device_id`, `is_new_device` (+ `idx_stepup_token`). |
| 0005 | `0005_mouse_modality.sql` | M10, ADR-0013 | `behavioral_baselines` and `enrollment_samples` gain a `modality` discriminator; baseline uniqueness re-keyed to `(user_id, modality, model_version)`; partial active-baseline index re-keyed to `(user_id, modality)`; new `idx_enrollment_user_modality`. |

> **Plus one runtime table not in `migrations/`:** `schema_migrations` is created by the runner
> itself (`CREATE TABLE IF NOT EXISTS …`), not by any `.sql` file. See §6.

---

## 2. Effective consolidated schema (SQL)

The final `CREATE TABLE` definition for each table after all migrations apply. Columns added by
later migrations appear at the end of their table (matching PostgreSQL's physical `ALTER TABLE …
ADD COLUMN` ordering); the originating migration is noted inline.

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- ===========================================================================
-- (a) IDENTITY & VAULT
-- ===========================================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        TEXT NOT NULL UNIQUE,
    auth_key_hash   TEXT NOT NULL,            -- Argon2id hash of the client-derived auth key
    kdf_version     INTEGER NOT NULL,
    kdf_salt        BYTEA   NOT NULL,
    kdf_params      JSONB   NOT NULL,         -- {memory_kib, iterations, parallelism}
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vault_keys (
    user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    wrapped_vault_key BYTEA NOT NULL,         -- vault key wrapped by the client; server cannot unwrap
    nonce             BYTEA NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vault_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext  BYTEA NOT NULL,               -- AEAD ciphertext of the whole credential record
    nonce       BYTEA NOT NULL,
    item_type   TEXT  NOT NULL DEFAULT 'login',
    revision    BIGINT NOT NULL DEFAULT 1,    -- optimistic concurrency for sync
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vault_items_user ON vault_items(user_id);

CREATE TABLE devices (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fingerprint_hash   TEXT NOT NULL,         -- hashed, never the raw fingerprint
    display_name       TEXT,
    trusted            BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, fingerprint_hash)
);

-- ===========================================================================
-- (b) BEHAVIORAL  (model-only, encrypted at rest, pseudonymized — ADR-0002)
-- ===========================================================================

CREATE TABLE behavioral_baselines (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_schema_version INTEGER NOT NULL,
    model_version          INTEGER NOT NULL,
    model_blob_encrypted   BYTEA NOT NULL,    -- encrypted fitted model: means + covariance
    model_nonce            BYTEA NOT NULL,
    sample_count           INTEGER NOT NULL DEFAULT 0,
    status                 TEXT NOT NULL DEFAULT 'enrolling'
                           CHECK (status IN ('enrolling','active','retired')),
    modality               TEXT NOT NULL DEFAULT 'keystroke'   -- 0005
                           CHECK (modality IN ('keystroke','mouse')),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT behavioral_baselines_user_modality_version_key       -- 0005 (replaces 0001 key)
        UNIQUE (user_id, modality, model_version)
);
CREATE INDEX idx_baselines_user_modality_active                     -- 0005 (replaces 0001 index)
    ON behavioral_baselines(user_id, modality) WHERE status = 'active';

CREATE TABLE enrollment_samples (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_vector         JSONB NOT NULL,    -- extracted features for this sample (purged on activation)
    captured_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    feature_schema_version INTEGER NOT NULL DEFAULT 1,            -- 0002
    modality               TEXT NOT NULL DEFAULT 'keystroke'      -- 0005
                           CHECK (modality IN ('keystroke','mouse'))
);
CREATE INDEX idx_enrollment_user          ON enrollment_samples(user_id);
CREATE INDEX idx_enrollment_user_modality ON enrollment_samples(user_id, modality);  -- 0005

-- ===========================================================================
-- (c) RISK / SESSIONS / STEP-UP
-- ===========================================================================

CREATE TABLE risk_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID REFERENCES users(id)   ON DELETE SET NULL,
    device_id        UUID REFERENCES devices(id) ON DELETE SET NULL,
    occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_truncated     TEXT,                        -- coarsened for privacy
    geo_country      TEXT,
    geo_region       TEXT,
    signals          JSONB NOT NULL,              -- per-signal {score, reason}
    behavioral_score NUMERIC,
    context_score    NUMERIC,
    composite_score  NUMERIC,                     -- 0003: NOT NULL dropped
    policy_band      TEXT CHECK (policy_band IN ('grant','step_up','deny')),  -- 0003: NOT NULL dropped
    action_taken     TEXT,                        -- 0003: NOT NULL dropped
    outcome          TEXT                         -- step_up_passed / step_up_failed / denied / …
);
CREATE INDEX idx_risk_events_user_time ON risk_events(user_id, occurred_at);

CREATE TABLE sessions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id          UUID REFERENCES devices(id) ON DELETE SET NULL,
    token_hash         TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','locked','revoked','expired')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at         TIMESTAMPTZ NOT NULL,
    last_risk_check_at TIMESTAMPTZ,
    is_new_device      BOOLEAN NOT NULL DEFAULT FALSE   -- 0003
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE login_failures (                  -- 0003
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL if username unknown
    ip_truncated TEXT,                          -- coarsened, never the full IP
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_failures_user_time ON login_failures(user_id, occurred_at);
CREATE INDEX idx_login_failures_ip_time   ON login_failures(ip_truncated, occurred_at);

CREATE TABLE totp_secrets (
    user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_encrypted BYTEA NOT NULL,            -- TOTP shared secret, encrypted at rest
    nonce            BYTEA NOT NULL,
    confirmed        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_step   BIGINT                      -- 0004: anti-replay (last accepted time-step)
);

CREATE TABLE step_up_challenges (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    UUID REFERENCES sessions(id) ON DELETE CASCADE,
    method        TEXT NOT NULL CHECK (method IN ('totp','email_otp')),
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','passed','failed','expired')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,
    token_hash    TEXT,                          -- 0004: hashed challenge handle
    device_id     UUID REFERENCES devices(id) ON DELETE SET NULL,  -- 0004
    is_new_device BOOLEAN NOT NULL DEFAULT FALSE -- 0004
);
CREATE INDEX idx_stepup_user  ON step_up_challenges(user_id);
CREATE INDEX idx_stepup_token ON step_up_challenges(token_hash);  -- 0004
```

---

## 3. Per-table column descriptions

### (a) Identity & Vault

#### `users` — account identity + KDF parameters for zero-knowledge login
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key; referenced by every per-user table. |
| `username` | TEXT | NO | — | Login identifier; globally unique. |
| `auth_key_hash` | TEXT | NO | — | Argon2id hash of the **auth key the client derives** (never the master password). Hashed again server-side for defense in depth. |
| `kdf_version` | INTEGER | NO | — | KDF parameter-set version, for rotation. |
| `kdf_salt` | BYTEA | NO | — | Per-user salt the client needs to re-derive its keys. |
| `kdf_params` | JSONB | NO | — | `{memory_kib, iterations, parallelism}` for client-side Argon2id. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | Row creation time. |

#### `vault_keys` — wrapped per-user vault key (server cannot unwrap)
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `user_id` | UUID | NO | — | **PK & FK** → `users(id)`; one key row per user. |
| `wrapped_vault_key` | BYTEA | NO | — | Vault key encrypted by the client's encryption key; opaque to the server. |
| `nonce` | BYTEA | NO | — | AEAD nonce used to wrap the vault key. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | Row creation time. |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | Last re-wrap time (master-password rotation re-wraps this row only). |

#### `vault_items` — encrypted credential records (the vault itself)
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | UUID | NO | — | **FK** → `users(id)`; owner. |
| `ciphertext` | BYTEA | NO | — | AEAD ciphertext of the entire credential (name, username, password, url, notes). |
| `nonce` | BYTEA | NO | — | AEAD nonce for this item. |
| `item_type` | TEXT | NO | `'login'` | Item kind (e.g. `login`). |
| `revision` | BIGINT | NO | `1` | Optimistic-concurrency counter for blob sync. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | Row creation time. |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | Last modification time. |

#### `devices` — known-device registry (new-vs-known context signal)
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | UUID | NO | — | **FK** → `users(id)`; owner. |
| `fingerprint_hash` | TEXT | NO | — | Hashed device fingerprint (raw fingerprint never stored). |
| `display_name` | TEXT | YES | — | Optional human-readable label. |
| `trusted` | BOOLEAN | NO | `FALSE` | Whether the user has marked the device trusted. |
| `first_seen` | TIMESTAMPTZ | NO | `now()` | First time this device was observed. |
| `last_seen` | TIMESTAMPTZ | NO | `now()` | Most recent observation. |

### (b) Behavioral

#### `behavioral_baselines` — fitted, encrypted per-user/per-modality model (model-only)
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | UUID | NO | — | **FK** → `users(id)`; owner. |
| `feature_schema_version` | INTEGER | NO | — | Feature-extractor schema the model was fitted under. |
| `model_version` | INTEGER | NO | — | Monotonic model version (re-fits bump it). |
| `model_blob_encrypted` | BYTEA | NO | — | Encrypted fitted model: means + covariance (Mahalanobis) + comparison models. **No raw captures.** |
| `model_nonce` | BYTEA | NO | — | AEAD nonce for the model blob. |
| `sample_count` | INTEGER | NO | `0` | Number of samples the model was fitted on. |
| `status` | TEXT | NO | `'enrolling'` | Lifecycle: `enrolling` / `active` / `retired` (CHECK). |
| `modality` | TEXT | NO | `'keystroke'` | Modality discriminator: `keystroke` / `mouse` (CHECK; added 0005). |
| `created_at` | TIMESTAMPTZ | NO | `now()` | Row creation time. |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | Last update time. |

#### `enrollment_samples` — ephemeral enrollment buffer (purged on activation)
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | UUID | NO | — | **FK** → `users(id)`; owner. |
| `feature_vector` | JSONB | NO | — | Extracted feature vector for one sample (deleted once the baseline becomes `active`). |
| `captured_at` | TIMESTAMPTZ | NO | `now()` | Capture time. |
| `feature_schema_version` | INTEGER | NO | `1` | Feature-schema version this sample was captured under (added 0002). |
| `modality` | TEXT | NO | `'keystroke'` | Modality: `keystroke` / `mouse` (CHECK; added 0005). |

### (c) Risk / Sessions / Step-up

#### `risk_events` — per-login risk decision log (the evaluation dataset)
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | UUID | YES | — | **FK** → `users(id)` `ON DELETE SET NULL`; nullable so events survive account deletion. |
| `device_id` | UUID | YES | — | **FK** → `devices(id)` `ON DELETE SET NULL`. |
| `occurred_at` | TIMESTAMPTZ | NO | `now()` | When the decision was made. |
| `ip_truncated` | TEXT | YES | — | Coarsened source IP (privacy). |
| `geo_country` | TEXT | YES | — | Resolved country (coarse geo). |
| `geo_region` | TEXT | YES | — | Resolved region (coarse geo). |
| `signals` | JSONB | NO | — | Per-signal sub-scores + structured reasons (explainability). |
| `behavioral_score` | NUMERIC | YES | — | Aggregated behavioral sub-score. |
| `context_score` | NUMERIC | YES | — | Aggregated contextual sub-score. |
| `composite_score` | NUMERIC | YES | — | Combiner output (nullable since 0003 for logging-only rows). |
| `policy_band` | TEXT | YES | — | `grant` / `step_up` / `deny` (CHECK; nullable since 0003). |
| `action_taken` | TEXT | YES | — | Enforcement action applied (nullable since 0003). |
| `outcome` | TEXT | YES | — | Resolution, e.g. `step_up_passed` / `step_up_failed` / `denied`. |

#### `sessions` — authenticated sessions + continuous-auth state
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | UUID | NO | — | **FK** → `users(id)` `ON DELETE CASCADE`; owner. |
| `device_id` | UUID | YES | — | **FK** → `devices(id)` `ON DELETE SET NULL`. |
| `token_hash` | TEXT | NO | — | Hash of the session token (raw token never stored). |
| `status` | TEXT | NO | `'active'` | `active` / `locked` / `revoked` / `expired` (CHECK). `locked` = continuous-auth spike. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | Session start. |
| `expires_at` | TIMESTAMPTZ | NO | — | Absolute expiry. |
| `last_risk_check_at` | TIMESTAMPTZ | YES | — | Last continuous-auth evaluation time. |
| `is_new_device` | BOOLEAN | NO | `FALSE` | Whether the login was from a new device (added 0003). |

#### `login_failures` — append-only failed-login log (failure-velocity signal)
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | UUID | YES | — | **FK** → `users(id)` `ON DELETE SET NULL`; NULL when the username is unknown (enumeration-safe). |
| `ip_truncated` | TEXT | YES | — | Coarsened source IP (never the full IP, never the attempted password). |
| `occurred_at` | TIMESTAMPTZ | NO | `now()` | Failure time. |

#### `totp_secrets` — per-user TOTP shared secret (step-up)
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `user_id` | UUID | NO | — | **PK & FK** → `users(id)` `ON DELETE CASCADE`; one secret per user. |
| `secret_encrypted` | BYTEA | NO | — | TOTP shared secret, encrypted at rest. |
| `nonce` | BYTEA | NO | — | AEAD nonce for the secret. |
| `confirmed` | BOOLEAN | NO | `FALSE` | Whether enrollment was confirmed by a valid code. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | Row creation time. |
| `last_used_step` | BIGINT | YES | — | Most recent accepted TOTP time-step; blocks replay (RFC 6238 §5.2; added 0004). |

#### `step_up_challenges` — pending/resolved step-up challenges
| Column | Type | Null? | Default | Description |
|--------|------|-------|---------|-------------|
| `id` | UUID | NO | `gen_random_uuid()` | Primary key. |
| `user_id` | UUID | NO | — | **FK** → `users(id)` `ON DELETE CASCADE`; owner. |
| `session_id` | UUID | YES | — | **FK** → `sessions(id)` `ON DELETE CASCADE`; session to issue/attach on success. |
| `method` | TEXT | NO | — | `totp` / `email_otp` (CHECK). |
| `status` | TEXT | NO | `'pending'` | `pending` / `passed` / `failed` / `expired` (CHECK). |
| `created_at` | TIMESTAMPTZ | NO | `now()` | Challenge creation time. |
| `expires_at` | TIMESTAMPTZ | NO | — | Challenge expiry. |
| `consumed_at` | TIMESTAMPTZ | YES | — | When the challenge was consumed. |
| `token_hash` | TEXT | YES | — | Hashed challenge handle (raw handle never stored; added 0004). |
| `device_id` | UUID | YES | — | **FK** → `devices(id)` `ON DELETE SET NULL`; device the pending login is for (added 0004). |
| `is_new_device` | BOOLEAN | NO | `FALSE` | Whether the pending login is from a new device (added 0004). |

---

## 4. Relationships (PK / FK / ON DELETE)

`users` is the root; nearly every table hangs off it. Two ON DELETE policies are used deliberately:
**CASCADE** for data that is meaningless without the user (vault, keys, baselines, sessions, secrets),
and **SET NULL** for audit/telemetry that must survive account deletion (`risk_events`,
`login_failures`) or optional device links.

| Child table | Column | → Parent | ON DELETE | Notes |
|-------------|--------|----------|-----------|-------|
| `vault_keys` | `user_id` (PK) | `users(id)` | CASCADE | 1:1 with user. |
| `vault_items` | `user_id` | `users(id)` | CASCADE | 1:N. |
| `devices` | `user_id` | `users(id)` | CASCADE | 1:N; `UNIQUE(user_id, fingerprint_hash)`. |
| `behavioral_baselines` | `user_id` | `users(id)` | CASCADE | 1:N (one per modality × model_version). |
| `enrollment_samples` | `user_id` | `users(id)` | CASCADE | 1:N; ephemeral. |
| `risk_events` | `user_id` | `users(id)` | **SET NULL** | Audit survives deletion. |
| `risk_events` | `device_id` | `devices(id)` | **SET NULL** | Optional device link. |
| `sessions` | `user_id` | `users(id)` | CASCADE | 1:N. |
| `sessions` | `device_id` | `devices(id)` | **SET NULL** | Optional device link. |
| `login_failures` | `user_id` | `users(id)` | **SET NULL** | NULL for unknown username; audit survives deletion. |
| `totp_secrets` | `user_id` (PK) | `users(id)` | CASCADE | 1:1 with user. |
| `step_up_challenges` | `user_id` | `users(id)` | CASCADE | 1:N. |
| `step_up_challenges` | `session_id` | `sessions(id)` | CASCADE | Optional session link. |
| `step_up_challenges` | `device_id` | `devices(id)` | **SET NULL** | Optional device link (0004). |

**Primary keys:** `users.id`, `vault_items.id`, `devices.id`, `behavioral_baselines.id`,
`enrollment_samples.id`, `risk_events.id`, `sessions.id`, `login_failures.id`,
`step_up_challenges.id` are surrogate UUIDs. `vault_keys.user_id` and `totp_secrets.user_id` are
**natural PKs** (the FK *is* the PK, enforcing 1:1 with `users`).

---

## 5. Indexes & CHECK constraints (per table)

| Table | Indexes (beyond PK) | UNIQUE constraints | CHECK constraints |
|-------|---------------------|--------------------|-------------------|
| `users` | — | `username` UNIQUE | — |
| `vault_keys` | — | — (PK is `user_id`) | — |
| `vault_items` | `idx_vault_items_user (user_id)` | — | — |
| `devices` | — | `UNIQUE (user_id, fingerprint_hash)` | — |
| `behavioral_baselines` | `idx_baselines_user_modality_active (user_id, modality) WHERE status='active'` (partial) | `behavioral_baselines_user_modality_version_key UNIQUE (user_id, modality, model_version)` | `status IN ('enrolling','active','retired')`; `modality IN ('keystroke','mouse')` |
| `enrollment_samples` | `idx_enrollment_user (user_id)`; `idx_enrollment_user_modality (user_id, modality)` | — | `modality IN ('keystroke','mouse')` |
| `risk_events` | `idx_risk_events_user_time (user_id, occurred_at)` | — | `policy_band IN ('grant','step_up','deny')` (applies to non-NULL values) |
| `sessions` | `idx_sessions_user (user_id)` | — | `status IN ('active','locked','revoked','expired')` |
| `login_failures` | `idx_login_failures_user_time (user_id, occurred_at)`; `idx_login_failures_ip_time (ip_truncated, occurred_at)` | — | — |
| `totp_secrets` | — | — (PK is `user_id`) | — |
| `step_up_challenges` | `idx_stepup_user (user_id)`; `idx_stepup_token (token_hash)` | — | `method IN ('totp','email_otp')`; `status IN ('pending','passed','failed','expired')` |

**Notes**
- `idx_baselines_user_modality_active` is a **partial** index — it indexes only `status='active'`
  rows, making "the user's currently-active baseline per modality" lookups cheap. It replaced the
  0001 index `idx_baselines_user_active (user_id) WHERE status='active'` in 0005.
- The 0001 unique key `behavioral_baselines_user_id_model_version_key (user_id, model_version)` was
  **dropped** in 0005 and replaced by the `(user_id, modality, model_version)` key above so that a
  user's keystroke and mouse baselines no longer collide.

---

## 6. Tables/columns present in the repo but NOT in the requested list

Requested list: `users, vault_keys, vault_items, devices, behavioral_baselines,
enrollment_samples, risk_events, sessions, totp_secrets, step_up_challenges, login_failures`.

**All 11 requested tables exist.** Exactly **one extra table** exists in any migrated database:

| Table | Origin | Why it exists | In a `.sql` migration? |
|-------|--------|---------------|------------------------|
| ⚠️ `schema_migrations` | Created at runtime by [`migrate.ts`](../migrations/migrate.ts#L31-L36) via `CREATE TABLE IF NOT EXISTS` | Migration bookkeeping — records each applied migration filename so re-runs are idempotent | **No** — it is created by the runner, not by any migration file |

```sql
-- Created by the migration runner, not by a migration file:
CREATE TABLE schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This table holds no user, vault, behavioral, or risk data — only migration filenames and timestamps.
It is operational metadata and can be excluded from the thesis data model, but it **is** physically
present in the database and is the only object beyond the 11 listed tables.

No other unexpected tables or columns were found: a repo-wide search for `CREATE TABLE` / `ALTER
TABLE` / `ADD COLUMN` returns only the five migration files and the runner.
