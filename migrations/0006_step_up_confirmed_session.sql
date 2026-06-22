-- 0006_step_up_confirmed_session.sql
-- Project Cerberus — demo-readiness. Records whether a session was issued via a
-- PASSED step-up (TOTP) in THIS session, so the read-only risk-inspector endpoint
-- (GET /risk/events) can be gated server-side on a step-up-confirmed session. The
-- inspector is a demonstration/research affordance; this changes no login/denial
-- enforcement or copy (ADR-0012). Forward-only — do not edit after it has run.
--
-- Default FALSE: existing/direct-grant sessions are NOT step-up-confirmed, so the
-- gate fails closed for them until a fresh TOTP step-up issues a confirmed session.
ALTER TABLE sessions ADD COLUMN step_up_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
