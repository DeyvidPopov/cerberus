# ADR-0011 — Contextual Risk Signals

- Status: **Accepted**
- Context: Milestone 8. The second head of the risk engine (context), alongside the
  M7 behavioral head.
- Related: PROJECT.md §1, §4.3, §4.4, §5; ADR-0002; `docs/threat-model.md`;
  ADR-0010 (behavioral scoring + risk_events); `migrations/0003_contextual_signals.sql`;
  `docs/geoip.md`.

## Context

Risk-based auth needs more than keystroke dynamics: where, when, from what device, and
under what failure pressure a login arrives. M8 adds four **independent, explainable**
contextual signals, evaluated per login and logged to the SAME `risk_events` row as the
behavioral signal. No enforcement, no aggregation, no policy band — those are M9.

## Decision

### 1. Four signals, each a pure `inputs → { score ∈ [0,1], reason }`

- **new-device** — from M4 enrollment. `known+trusted → 0`, `known+untrusted → 0.3`,
  `unseen → 1`. "Known before this login" is the **authoritative `isNew`** captured from
  device enrollment AT login time (stored on the session: `sessions.is_new_device`), not
  a fragile first-seen-vs-now timestamp heuristic.
- **geovelocity** — coarse country centroids + great-circle distance / Δtime → implied
  km/h, mapped through a `[normalKmh, impossibleKmh]` band to `[0,1]`. Country granularity
  only (intra-country travel is invisible by design — privacy).
- **time-of-day** — the user's prior login hours as a **circular** distribution (mean
  resultant vector); deviation of the current hour from the mean, normalized by the
  (floored) circular dispersion, saturating at `z = saturationZ`. UTC throughout.
- **failure-velocity** — recent failed logins per account AND per IP in a config window,
  scaled by the larger count. Failures are recorded at `/auth/login` into an append-only
  `login_failures` store (user_id nullable for unknown usernames; truncated IP only).

Every threshold/window is named config in `risk/config.ts` (PROJECT.md §4.4) — no magic
numbers. Each signal is independently unit-tested.

### 2. The cold-start rule (mandatory)

A new user / new device / sparse history must NOT be penalized for lack of data. The
history-dependent signals return **NEUTRAL (0) with `lowConfidence`** when they cannot
judge: geovelocity with no prior location (or unresolved geo), time-of-day below
`minHistory` prior logins, failure-velocity with zero failures. The only signal that
fires for a newcomer is **new-device on a genuinely unseen device** — which is correct
(it is a new device; M9 decides the response), not a penalty for being new. Asserted in
tests.

### 3. GeoIP + privacy (PROJECT.md §5)

Offline **MaxMind GeoLite2-City** `.mmdb`, fetched locally and **gitignored**
(`docs/geoip.md`); no external geo API. The lookup returns **only** country/region ISO
codes — precise latitude/longitude are discarded at the boundary and never used or
stored. `risk_events` persists **coarse geo (country/region) + a truncated IP** (IPv4
/24, IPv6 /48); the full IP is transient (lookup + truncation) and never persisted.
`trust proxy` is configured (env `TRUST_PROXY`) so the real client IP is read behind a
reverse proxy (the M4 open item). With no database present (e.g. CI), the lookup degrades
to null and geovelocity stays neutral.

### 4. Integration — one combined row per login, logged not enforced

The post-login keystroke submission is Cerberus's per-login risk-evaluation point (the
single place the keystroke vector AND the full request context coexist). On every
submission the behavioral facade evaluates the four contextual signals and the behavioral
leg and writes **ONE** `risk_events` row aggregating all five sub-scores, each with its
reason. `composite_score`, `context_score`, `policy_band`, and `action_taken` are left
**NULL** — M9 owns the combiner. (Migration 0003 makes those columns nullable, superseding
ADR-0010's observational placeholder values.) Nothing is enforced; the scores are never
returned to the client.

### 5. failure-velocity is the basis for the M9 lockout reconsideration

M8 implements the failure-velocity **signal** only. It does NOT touch the crude M4
per-account lockout — M9 will reconsider that lockout (and its DoS trade-off) using this
signal as the principled, per-account-and-per-IP rate measure.

## Consequences

- New server modules: `risk/signals/*` (four signals + types), `risk/geo/*` (centroids,
  haversine), `services/geoip.ts`, `services/contextual-risk.ts`; a `login_failures`
  repository; extended `devices`/`sessions`/`risk-events` repositories. New dependency:
  `maxmind` (pure-JS offline reader; 0 production vulnerabilities).
- `risk_events` becomes a multi-signal record; M9 reads one row and computes the band.
- The behavioral row is now created on every submission (enrolling included), so newcomers
  are contextually logged from login 1.

## Alternatives considered

- **Evaluate contextual signals at `/auth/login` and merge behavioral later** (session
  correlation) — rejected as more complex (cross-request correlation, an extra UPDATE) for
  no benefit over evaluating both at the single post-login telemetry point.
- **First-seen-vs-now heuristic for new-device** — rejected as fragile for rapid
  re-logins; the authoritative login-time `isNew` on the session is exact.
- **Precise-coordinate geovelocity** — rejected; persisting coordinates violates §5.
  Country-centroid distance catches cross-country impossible travel while storing only
  coarse geo.
- **An external geo API** — rejected; offline only (no per-login data sent to a third
  party, no network dependency in the auth path).
- **Setting `policy_band='grant'` placeholders (ADR-0010 style)** — superseded; nullable
  columns let M7+M8 log pure sub-scores and leave the decision to M9.
