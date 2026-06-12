-- 0003_contextual_signals.sql
-- Project Cerberus — Milestone 8 (contextual risk signals). ADR-0011.
-- Forward-only migration. Do not edit after it has run anywhere.
--
-- Two changes:
--  1. risk_events: M7 + M8 log per-signal SUB-SCORES only; the composite/context
--     score, the policy band, and the action are computed by the M9 combiner.
--     Make those columns NULLABLE so a logging-only row leaves them unset (this
--     supersedes ADR-0010's observational placeholder values). The CHECK on
--     policy_band still constrains non-NULL values to grant/step_up/deny.
--  2. login_failures: an append-only store of failed login attempts feeding the
--     failure-velocity signal (per account and per IP). Only a TRUNCATED IP and an
--     optional user_id are stored — never the attempted password or the full IP
--     (PROJECT.md §5). user_id is NULL for an unknown username (enumeration-safe).

ALTER TABLE risk_events ALTER COLUMN composite_score DROP NOT NULL;
ALTER TABLE risk_events ALTER COLUMN policy_band     DROP NOT NULL;
ALTER TABLE risk_events ALTER COLUMN action_taken    DROP NOT NULL;

-- Record whether the device was NEW at this login (authoritative — captured from
-- device enrollment at login time, which the new-device signal reads rather than
-- inferring it later from timestamps).
ALTER TABLE sessions ADD COLUMN is_new_device BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE login_failures (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES users(id) ON DELETE SET NULL, -- NULL if username unknown
    ip_truncated TEXT,                                         -- coarsened, never the full IP
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_failures_user_time ON login_failures(user_id, occurred_at);
CREATE INDEX idx_login_failures_ip_time   ON login_failures(ip_truncated, occurred_at);
