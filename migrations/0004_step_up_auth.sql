-- 0004_step_up_auth.sql
-- Project Cerberus — Milestone 9 (adaptive policy + TOTP step-up). ADR-0012.
-- Forward-only migration. Do not edit after it has run anywhere.
--
--  1. totp_secrets.last_used_step: the most recent TOTP time-step accepted for
--     this user, so a used code/counter cannot be replayed (RFC 6238 §5.2).
--  2. step_up_challenges: carry a hashed challenge handle (like a session token —
--     the raw handle is never stored) plus the device the pending login is for, so
--     the session can be issued on successful TOTP verify. (id, user_id, session_id,
--     method, status, created_at, expires_at, consumed_at already exist in 0001.)

ALTER TABLE totp_secrets ADD COLUMN last_used_step BIGINT;

ALTER TABLE step_up_challenges ADD COLUMN token_hash    TEXT;
ALTER TABLE step_up_challenges ADD COLUMN device_id     UUID REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE step_up_challenges ADD COLUMN is_new_device BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_stepup_token ON step_up_challenges(token_hash);
