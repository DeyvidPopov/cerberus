# ADR-0012 — Adaptive Policy, Enforcement & TOTP Step-Up

- Status: **Accepted**
- Context: Milestone 9. The first ENFORCING milestone — the third head of Cerberus
  (the combiner that decides) closes over M7 (behavioral) + M8 (contextual).
- Related: PROJECT.md §1, §4.3, §4.4, §5; ADR-0002 (fail closed), ADR-0007 (login/
  sessions), ADR-0010 (behavioral score), ADR-0011 (contextual signals + the
  failure-velocity-as-lockout note); `migrations/0004_step_up_auth.sql`.

## Context

M7 and M8 LOG sub-scores; nothing is enforced. M9 turns them into decisions: a
combiner → a policy band → enforcement at the login decision point, with TOTP
step-up, and a replacement for the crude M4 per-account lockout.

The behavioral sub-score needs the keystroke timing, which is captured during the
master-password entry. Enforcement therefore moves the keystroke sample **into the
login request** (durations only, never characters — the privacy model is
unchanged). Login becomes the single evaluation + enforcement point; the
`/enrollment/samples` endpoint reverts to pure baseline **buffering** (it no longer
scores or logs). This is the only place the keystroke vector AND the full request
context coexist, so no cross-request correlation is needed.

## Decision

### A. The combiner (explainable, weighted-linear)

`composite = clamp01( Σ weightᵢ · subscoreᵢ )` over the behavioral + four
contextual sub-scores. Weights are NOT normalized to sum 1, so a single strong
signal reaches step_up and stacked strong signals reach deny. `context_score` is
the contextual portion. The **per-signal contributions** (`weightᵢ · subscoreᵢ`)
are stored in the risk_events reason, so every decision is reconstructible
(PROJECT.md §1). Starting weights (named config, `risk/config.ts`):

| behavioral | new-device | geovelocity | time-of-day | failure-velocity |
|-----------:|-----------:|------------:|------------:|-----------------:|
| 0.50 | 0.35 | 0.50 | 0.20 | 0.35 |

Behavioral weight 0.5 reflects keystroke dynamics as a moderately strong
discriminator (M7 EER ≈ 13%). `composite_score` + `context_score` are written to
the risk_events row (the columns M8 made nullable).

### B. Policy bands + enforcement

`composite ≥ deny → deny; ≥ stepUp → step_up; else grant` (thresholds **stepUp
0.30, deny 0.70**, named config). Ties escalate (fail closed). At login:

- **grant** → issue the session.
- **step_up** → withhold the session; create a single-use, hashed, device-bound,
  expiring step-up challenge; the client satisfies it with a TOTP code.
- **deny** → 403, no session, logged. Deny is **per-attempt** (retry from a clean
  context), never a timed lock.

`policy_band` records the banded decision; `action_taken` records what was enforced
(`granted` / `step_up_required` / `denied` / `step_up_bootstrap_grant`).

### C. Fail closed on missing/suppressed telemetry

A user with an ACTIVE baseline who sends **no** keystroke sample, or a sample whose
dimension/schema does not match the baseline, gets behavioral sub-score **1**
(confidence `missing`) and the band **escalates to at least step_up**. Suppressing
telemetry is not a bypass. Enrolling users (no baseline) are **cold-start neutral**
(sub-score 0) — a legitimate newcomer is never penalized for lack of data.

### D. Newcomer bootstrap

A step_up band requires a second factor. A user **without a confirmed TOTP secret**
cannot complete step-up; how that resolves depends on WHY the band escalated
(gated on the behavioral confidence, so suppressing telemetry can never bypass the
behavioral layer):

- behavioral confidence **`missing`** (active baseline, but the sample was
  suppressed or mismatched) → **fail closed to a denial** (`action = denied`). An
  attacker with a stolen password on a known device cannot defeat the behavioral
  check by omitting the keystroke sample.
- behavioral confidence **`low`/`normal`** (a genuine newcomer still enrolling, or a
  returning user who DID provide valid telemetry on, e.g., a new device) →
  **logged bootstrap GRANT** (`action = step_up_bootstrap_grant`), so a new user can
  always get in and set up TOTP.

**deny still denies** (a genuinely high-risk context — retry from a clean one; it is
not an inescapable lock). Once TOTP is confirmed, full step-up enforcement applies.

### E. TOTP step-up (RFC 6238)

HMAC-SHA1, 6 digits, 30 s, ±1 window skew. The secret is generated server-side,
stored **encrypted at rest** (AES-256-GCM via `secretbox`, the server-managed key,
AAD bound to the user id), and is `unconfirmed` until the user proves possession
(`/auth/totp/confirm`). Verification is **constant-time** and **replay-protected**:
each accept advances a monotonic `last_used_step`; a code at a step ≤ the watermark
is rejected, so a used code/counter cannot be reused. A wrong code does not consume
the challenge (a typo is retryable within the TTL) but is recorded (feeds
failure-velocity).

### F. Brute-force model (replaces the M4 lockout)

The M4 per-account timed lockout enabled a targeted availability DoS (an attacker
locks a victim with wrong guesses). It is **removed** and replaced by:

- **Adaptive primary** — high failure-velocity raises the composite → step_up
  (escapable with TOTP). A single signal never reaches deny alone, so failures
  alone never deny a legitimate user; the attacker (wrong password) never verifies.
- **Absolute backstop** — a HIGH per-IP failed-login cap (config, default 50/15 min)
  hard-blocks an abusive source; a high per-account failure cap escalates to step_up
  (not a hard lock). A single username therefore cannot be cheaply locked out.

## Consequences

- New server modules: `risk/combiner`, `risk/policy`, `services/{totp, totp-service,
  secretbox, risk-decision}`, `repositories/{totp-secrets, step-up-challenges}`; new
  routes `/auth/step-up/verify`, `/auth/totp/setup`, `/auth/totp/confirm`; migration
  0004 (replay watermark + challenge handle/device). `LoginRequest` gains an optional
  keystroke sample; `LoginResponse` is a discriminated union (granted / step-up).
- The M4 `AccountLockout` + `loginRateLimit` are gone; login uses the per-IP request
  limiter + the DB-backed absolute backstop.
- M7 scoring + M8 contextual logging now happen at login; their tests are
  login-based. `/enrollment/samples` is pure buffering again.

## Alternatives considered

- **Two-phase login** (issue a pending session, evaluate on the later telemetry
  submission) — rejected; a "pending session" is a partial grant, and correlation is
  complex. Evaluating everything at login with the sample is simpler and correct.
- **A hard per-account failure lock** (M4 style, set higher) — rejected; any hard
  per-account lock is a targeted DoS. The adaptive-primary + per-IP-hard-cap +
  per-account-step_up model removes the DoS while still resisting brute force.
- **A TOTP library** — rejected; a ~60-line auditable RFC 6238 implementation (no
  dependency) is better for a security thesis and is KAT-tested against the RFC
  vectors.
- **Deny for a no-TOTP newcomer at a step_up band** — rejected; it would brick
  legitimate newcomers. step_up-without-second-factor bootstraps to a logged grant.
