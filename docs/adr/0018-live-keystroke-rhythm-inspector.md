# ADR-0018 — Live keystroke rhythm in the gated inspector

- Status: **Accepted (scoped relaxation — reversible)**
- Context: Risk & Behavior Inspector. Makes panel 3 ("keystroke rhythm · baseline vs
  current") show the user's REAL data instead of an illustrative overlay.
- Related: **ADR-0002** (behavioral baselines model-only, never returned over the API) —
  this ADR deliberately and narrowly RELAXES that; ADR-0009 (feature schema), ADR-0012
  (step-up), PROJECT.md §5; `routes/risk.ts`, `services/risk-inspector.ts`,
  `packages/shared-types/src/behavioral.ts`, `features/inspector/RiskDashboard.tsx`.

## Context

ADR-0002 / invariant #4 (CLAUDE.md): behavioral feature vectors are biometric-adjacent —
"never logged beside identity, never returned raw over the API"; raw samples are purged on
activation and only the encrypted mean+covariance model survives server-side. Consequently
the inspector's rhythm panel was **always illustrative** (a random walk around a hardcoded
baseline, honestly labelled). The owner asked to see the **real** baseline-vs-current rhythm
for the demo, accepting that this relaxes the invariant, and asked for it to be reversible.

## Decision

Expose the rhythm to the OWNING user only, behind the existing inspector gate. This is a
**deliberate, narrow relaxation of ADR-0002** for a demonstration/research affordance — not
a change to the default privacy posture.

- **Server** — `GET /risk/keystroke-rhythm` returns the caller's OWN enrolled keystroke
  baseline as display durations `{ hold[n], flight[n−1] }` (per-key dwell + down-to-down
  interval), or `{ rhythm: null }` if still enrolling. It is chained behind the SAME gate as
  `/risk/events`: `authenticate → requireStepUp → rateLimit`, and the user id comes from the
  authenticated session, never the request (no IDOR). The fitted mean is decrypted server-side
  and mapped via the single shared `keystrokeRhythmFromVector` (same layout as
  `extractFeatureVector`). The outgoing shape is zod-validated. **Hard-gated to non-production**
  (`demoOverridesAllowed(nodeEnv)`, the same gate the demo deny breakdown uses): in a production
  build the route is **not mounted at all** (404), so a shipped server never exposes a baseline.
  The non-biometric `/risk/events` stays available in every environment.
- **Client** — the desktop keeps THIS sign-in's real captured vector in memory only
  (`AuthenticatedSession.keystrokeVector`, carried through any step-up, cleared on lock) and
  the inspector plots real baseline (dashed) vs real current (solid), with the real per-position
  deviation driving the "Δ baseline" readout + flag. The panel chip flips from
  "illustrative — simulated data" to "live · your keystrokes" ONLY when both real inputs are
  present; otherwise it falls back to the honest illustrative overlay.

### What is and is NOT exposed

- **Is:** the caller's own fitted baseline mean as hold/flight durations, and (client-side
  only) their own current login vector. Biometric-adjacent — this is the relaxation.
- **Is NOT:** any character / the password (the capture path structurally cannot read key
  identity); the covariance or other model internals; any OTHER user's data (scoped to self);
  raw enrolment samples (purged — never existed to return); historical attempts' vectors
  (purged — older audit-trail rows stay illustrative). At-rest encryption of the model is
  unchanged; vault zero-knowledge (Rust core) is untouched.

## Consequences

- The rhythm panel is genuinely live for the current session when the user has an active
  keystroke baseline; it degrades gracefully (illustrative) while enrolling, on a dimension
  mismatch, or for historical rows.
- **The privacy posture is weakened in exactly one place, and only outside production:** a
  step-up-confirmed session can read its own biometric baseline over the API. The blast radius is
  bounded by the gate (non-production only, self only, TOTP-confirmed, rate-limited) and by
  returning durations only. A shipped build does not mount the route — the default posture is
  unchanged in production.
- A biometric vector now lives transiently in webview memory (the current sign-in's), against
  the ADR-0002 minimisation principle. Cleared on lock; never persisted, never re-sent.
- Tests: server `(k)` asserts the gate + self-scoping + shape; desktop asserts the panel flips
  to live with real inputs and stays illustrative without a baseline.

## Reversibility

Self-contained and revertable without touching ADR-0016/0017 work: the new route + service
method + shared mapping + `KeystrokeRhythmResponse` schema + the client `keystrokeVector`
thread + the panel's live branch. Reverting restores the always-illustrative panel and the
strict ADR-0002 posture. No migration was added; no stored data changed.

## Alternatives considered

- **Relabel only (keep illustrative)** — the honest, zero-relaxation option; rejected here
  because the owner explicitly wanted the real data and accepted the trade-off. Remains the
  recommended posture for a shipped product.
- **Current line live, baseline illustrative** — avoids the server relaxation but isn't the
  "baseline vs current" the owner asked for.
- **Return per-position deviations instead of absolute timings** — still a transform of the
  biometric pattern (same rule call), and harder to render faithfully; no real privacy win.
