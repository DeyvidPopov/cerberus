-- 0001_initial_schema.sql
-- Project Cerberus — initial schema.
-- Forward-only migration. Do not edit after it has run anywhere.
--
-- Design invariants (see PROJECT.md, ADR-0001, ADR-0002):
--   * The server stores ONLY ciphertext, hashes, and non-secret telemetry.
--   * No plaintext credentials, no master password, no derived keys are ever stored.
--   * Behavioral baselines are model-only, encrypted at rest, pseudonymized.
--   * Risk thresholds/policy bands live in application config, NOT in this schema.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Identity & zero-knowledge login
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        TEXT NOT NULL UNIQUE,
    -- Argon2id hash of the auth key the client derives (NOT the master password).
    auth_key_hash   TEXT NOT NULL,
    -- KDF parameters the client needs to re-derive its keys. Versioned for rotation.
    kdf_version     INTEGER NOT NULL,
    kdf_salt        BYTEA   NOT NULL,
    kdf_params      JSONB   NOT NULL,  -- {memory_kib, iterations, parallelism}
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The per-user vault key, wrapped (encrypted) by the client's encryption key.
-- Server cannot unwrap it. Rotating the master password re-wraps this row only.
CREATE TABLE vault_keys (
    user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    wrapped_vault_key BYTEA NOT NULL,
    nonce            BYTEA NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The vault (opaque to the server)
-- ---------------------------------------------------------------------------
CREATE TABLE vault_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- AEAD ciphertext of the whole credential (name, username, password, url, notes).
    ciphertext  BYTEA NOT NULL,
    nonce       BYTEA NOT NULL,
    item_type   TEXT  NOT NULL DEFAULT 'login',
    revision    BIGINT NOT NULL DEFAULT 1,  -- optimistic concurrency for sync
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vault_items_user ON vault_items(user_id);

-- ---------------------------------------------------------------------------
-- Devices (context signal: known vs new)
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fingerprint_hash   TEXT NOT NULL,      -- hashed, not raw fingerprint
    display_name       TEXT,
    trusted            BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, fingerprint_hash)
);

-- ---------------------------------------------------------------------------
-- Behavioral baselines (MODEL ONLY, encrypted at rest, pseudonymized) — ADR-0002
-- ---------------------------------------------------------------------------
CREATE TABLE behavioral_baselines (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_schema_version INTEGER NOT NULL,
    model_version         INTEGER NOT NULL,
    -- Encrypted fitted model: means + covariance (Mahalanobis), fitted comparison models.
    -- NO raw keystroke/mouse captures are stored here.
    model_blob_encrypted  BYTEA NOT NULL,
    model_nonce           BYTEA NOT NULL,
    sample_count          INTEGER NOT NULL DEFAULT 0,
    status                TEXT NOT NULL DEFAULT 'enrolling'
                          CHECK (status IN ('enrolling','active','retired')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, model_version)
);
CREATE INDEX idx_baselines_user_active
    ON behavioral_baselines(user_id) WHERE status = 'active';

-- Ephemeral enrollment buffer. PURGED once the baseline becomes 'active'
-- (data minimization, ADR-0002). Never retained long-term.
CREATE TABLE enrollment_samples (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_vector JSONB NOT NULL,  -- extracted features for this sample
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_enrollment_user ON enrollment_samples(user_id);

-- ---------------------------------------------------------------------------
-- Risk decisions — THIS IS THE EVALUATION DATASET (PROJECT.md §4.4)
-- ---------------------------------------------------------------------------
CREATE TABLE risk_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
    device_id        UUID REFERENCES devices(id) ON DELETE SET NULL,
    occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_truncated     TEXT,                 -- coarsened for privacy
    geo_country      TEXT,
    geo_region       TEXT,
    -- Each signal's sub-score + structured reason (explainability requirement).
    signals          JSONB NOT NULL,       -- {keystroke:{score,reason}, newDevice:{...}, ...}
    behavioral_score NUMERIC,
    context_score    NUMERIC,
    composite_score  NUMERIC NOT NULL,
    policy_band      TEXT NOT NULL CHECK (policy_band IN ('grant','step_up','deny')),
    action_taken     TEXT NOT NULL,
    outcome          TEXT                  -- e.g. step_up_passed / step_up_failed / denied
);
CREATE INDEX idx_risk_events_user_time ON risk_events(user_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Sessions & continuous auth
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id          UUID REFERENCES devices(id) ON DELETE SET NULL,
    token_hash         TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','locked','revoked','expired')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at         TIMESTAMPTZ NOT NULL,
    last_risk_check_at TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------------
-- Step-up authentication (TOTP per RFC 6238, or email OTP)
-- ---------------------------------------------------------------------------
CREATE TABLE totp_secrets (
    user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_encrypted  BYTEA NOT NULL,   -- TOTP shared secret, encrypted at rest
    nonce             BYTEA NOT NULL,
    confirmed         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE step_up_challenges (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id  UUID REFERENCES sessions(id) ON DELETE CASCADE,
    method      TEXT NOT NULL CHECK (method IN ('totp','email_otp')),
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','passed','failed','expired')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE INDEX idx_stepup_user ON step_up_challenges(user_id);