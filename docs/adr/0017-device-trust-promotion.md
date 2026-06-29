# ADR-0017 — Device trust is earned by sustained use

- Status: **Accepted**
- Context: Follow-up to the ADR-0016 note. Makes the new-device signal's `trusted` tier
  (ADR-0011) reachable.
- Related: ADR-0011 (new-device signal), ADR-0016 (confirmed-login baseline);
  `services/auth.ts`, `repositories/sessions.ts`, `repositories/devices.ts`,
  `risk/config.ts`.

## Context

The new-device signal scores a device by status: `unseen → 1.0`, `known-untrusted → 0.3`,
`known-trusted → 0` ([ADR-0011](0011-contextual-risk-signals.md)). A device is enrolled on
its first login (`isNew` true for that one login, then known forever). But **nothing ever
set `trusted = true`** — there was no promotion path — so every returning device sat
permanently at known-untrusted `0.3`, contributing a fixed `0.3 × 0.35 = 0.105` to the
composite on every login, forever. The `known-trusted → 0` tier was effectively dead code,
and a genuinely established primary device never stopped looking mildly risky.

## Decision

A device graduates **known-untrusted → known-trusted** once it has **CONFIRMED logins (issued
sessions) on at least `trustAfterDistinctDays` distinct UTC calendar days** (default **5**,
named config in `risk/config.ts`). Trust is **earned by sustained real use over time**, not by
volume or mere elapsed time:

- **Distinct days, not logins** — many logins on a single day count once, so a burst can't
  fast-track trust (asserted in tests).
- **Confirmed logins only** — the count is over `sessions` (a session = an issued login:
  grant, newcomer bootstrap grant, or passed step-up). A denied / un-passed step-up issues no
  session, so it earns nothing — consistent with ADR-0016's "confirmed presence" model.
- **Not elapsed time** — a once-seen device left idle never trusts itself; the rejected
  alternative (trust after N elapsed days) would let an attacker log in once and wait out the
  clock.

Mechanism: after `issueSession` writes the session, if the device is a returning one
(`!isNewDevice`) and its distinct-day count meets the threshold, `devices.markTrusted` flips
the row (idempotent + monotonic). The promotion takes effect on the **next** login (the
triggering login was already scored before its session existed). Trust is durable until the
device row is removed (e.g. account deletion cascades it).

## Consequences

- The `known-trusted → 0` tier is now reachable: an established primary device stops
  contributing `0.105` to every composite once it has been used across 5 distinct days.
- New device-management surface is intentionally minimal: trust is auto-earned, monotonic, and
  per-`(user, fingerprint)`. There is still **no explicit "trust/untrust this device" UI** and
  **no trust revocation** — candidate follow-ups if device management becomes a feature.
- Demo note: the threshold is calendar-day based, so it can't be exercised live in one sitting;
  tests (and a demo) backdate sessions to simulate prior days. A dev-only env override could be
  added if a live walkthrough is wanted.
- Tests (`routes/device-trust.test.ts`) assert promotion after distinct-day use (`0.3 → 0`) and
  that single-day volume does **not** earn trust.

## Alternatives considered

- **Trust after N elapsed days (age only)** — rejected: a device seen once and idle would
  self-trust; an attacker could log in once and wait. Sustained use is the stronger anchor.
- **Trust after N logins (any days)** — rejected: a same-session burst would fast-track trust.
  Requiring distinct days forces the use to be spread over time.
- **Count all risk-evaluated attempts** — rejected for the same reason as ADR-0016: a denied
  attempt is not confirmed presence and must not earn trust. Only issued sessions count.
- **Explicit user "trust this device" toggle** — deferred: heavier (device-management UI,
  revocation, secure listing) and orthogonal to making the existing tier reachable.
