# ADR-0013 — Continuous Authentication: Mouse Dynamics, Windowed Streaming & Spike→Lock

- Status: **Accepted**
- Context: Milestone 10. The first CONTINUOUS (in-session) authentication: the second
  behavioral modality (mouse dynamics) re-uses the existing behavioral machinery and
  closes the loop from "authenticate at the gate" to "keep watching while unlocked."
- Related: PROJECT.md §1 (fail closed), §4.4 (no magic numbers), §5 (biometric-adjacent
  data); ADR-0002 (server-side authoritative scoring, model-only baselines); ADR-0009
  (enrollment lifecycle, regularized covariance, model-only at-rest); ADR-0010
  (Mahalanobis→χ² scorer); ADR-0012 (bands, fail-closed, step-up);
  `migrations/0005_mouse_modality.sql`.

## Context

M6–M9 authenticate at login (keystroke + context → a banded decision). Once the vault
is unlocked the session is trusted indefinitely — a walk-away or a session takeover is
invisible. M10 adds **continuous authentication**: during an open session the client
streams mouse-dynamics telemetry; the server scores it and, on a sustained anomaly,
**locks the vault** and forces a re-unlock.

The hard requirement (and the interesting design constraint) is **reuse**: the scorer,
the enrollment lifecycle, and the policy primitives are modality-agnostic and must NOT
be duplicated per modality.

## Decision

### A. Mouse feature schema (versioned, fixed-dimension) — `@cerberus/shared-types/mouse`

A captured window is summarized into a **fixed 9-dim** feature vector (vs. keystroke's
password-length-parametric vector): velocity (mean, std), acceleration (mean, std),
turning-angle/curvature (mean, std), click rate + mean click duration, and pause rate.
`MOUSE_FEATURE_SCHEMA_VERSION = 1` is stamped on every window and on the fitted baseline.
**One extractor** (`extractMouseWindowFeatures`) is the single source of truth, exactly
as for keystroke — capture (client) and any server-side use cannot drift.

The privacy model is unchanged and structural (PROJECT.md §5): capture records only
pointer **coordinates + timestamps + event kind** (move/press/release). There is no field
that can carry the event target, the element under the pointer, or any content. The raw
pointer trail never leaves the device — only the aggregated, biometric-adjacent window
vector is streamed, and only the **model** (mean + covariance) is persisted, encrypted.

### B. Sliding window (named config)

The client buffers `MOUSE_WINDOW_SIZE` (32) positional samples and emits one feature
vector per window, then slides forward by `MOUSE_WINDOW_STEP` (16), so consecutive
windows overlap 50% and a spike is caught within one step. All window/threshold values
are named config (PROJECT.md §4.4), never literals.

### C. Mouse baseline REUSES the M6 enrollment lifecycle (modality-parameterized)

The `behavioral_baselines` and `enrollment_samples` tables gain a `modality`
discriminator (`'keystroke' | 'mouse'`, default `'keystroke'`), and per-user uniqueness
becomes `(user_id, modality, model_version)` (migration 0005). The repositories and the
enrollment service take a `modality` parameter (defaulting to keystroke, so every M6–M9
call site is unchanged). The SAME lifecycle — accumulate windows → fit mean + Ledoit-Wolf
+ ridge covariance → encrypt model-only at rest → **purge raw** → activate — fits the
mouse baseline. No parallel "mouse enrollment service" exists.

Mouse windows are **buffered during the open session over the stream itself** (mirroring
how M9 buffers the login keystroke sample): with no active mouse baseline, each window is
appended toward the baseline; once `MOUSE_MIN_ENROLLMENT_SAMPLES` windows accumulate, the
baseline activates and subsequent windows are scored.

### D. In-session scoring REUSES the M7 Mahalanobis→χ² scorer

Each window is scored by the identical modality-agnostic `scoreSample` (D² → χ² CDF). The
window sub-score folds into a per-session **EWMA composite** (`composite ← α·sub +
(1−α)·composite`, named config). This is the in-session analogue of the login combiner;
because continuous auth this milestone is mouse-only (a single signal), no multi-signal
combiner is run in-session — the existing combiner is left unchanged, not duplicated.

### E. Spike → LOCK (fail closed)

When the composite crosses `spikeThreshold` (named config) the server: (1) records the
decision in `risk_events` (`signals.mouse` + reason, `policy_band='deny'`,
`action_taken='session_locked'`); (2) marks the session **locked** so the bearer token no
longer authenticates; (3) sends the client a generic `{ type: 'locked', reason: 'risk' }`
(no signal/score detail leaks); (4) closes the socket. The client zeroizes keys via the M3
lock path and returns to the unlock screen. **Re-unlock re-runs the M9 login risk
evaluation** — a mid-session spike costs the user access until they re-prove. The EWMA
smooths single-window noise: a lone anomalous window cannot lock; a sustained spike does.

### F. Cold-start neutrality

A session with **no active mouse baseline** (still enrolling) is **neutral**: windows only
buffer toward the baseline; nothing is scored, so nothing can spike. A legitimate user is
never spuriously locked for lack of data (mirrors the M8 cold-start rule, ADR-0011/0012).

### G. Session-authenticated WebSocket transport

Telemetry streams over a WebSocket at `CONTINUOUS_AUTH_WS_PATH`. The HTTP **upgrade** is
verified against an ACTIVE session **before** the socket is accepted (fail closed on a
missing/invalid session). The token arrives as `Authorization: Bearer <t>` (non-browser
clients) or as a `bearer.<token>` subprotocol (the browser WebSocket cannot set headers;
the server reads the token from the offered subprotocols and echoes only the main one).
Windows are processed strictly in order per connection (the EWMA is mutable state). Scoring
is server-side and authoritative (ADR-0002); the client never reports its own verdict, and
losing the stream cannot grant access (fail-safe).

## Consequences

- New shared module `@cerberus/shared-types/mouse` (schema + extractor + WS contract); new
  server `risk/continuous-auth` (EWMA + spike band), `services/continuous-auth` (reuses the
  enrollment + scoring services for `modality='mouse'`), `ws/` (the transport);
  `sessions.markLocked`; new desktop `lib/mouse-capture`, `lib/ws`, and VaultView wiring.
  Migration 0005 adds the `modality` discriminator. The server bootstrap now wraps the
  Express app in an `http.Server` to host the upgrade.
- Per-window scores are evaluated in memory; only the actionable **lock decision** is
  persisted to `risk_events`. This both avoids flooding the evaluation dataset and
  minimizes stored biometric-derived data (no per-window score stream beside identity).
- The baseline at-rest AAD remains bound to `user_id` (baseline-crypto is unchanged, per
  the M10 "no crypto-core changes" constraint). Modality separation is enforced by the
  per-modality DB row and by dimension/schema-version checks that fail closed — a
  cross-modality blob swap for the same user decrypts but then fails to score.

## Alternatives considered

- **A separate mouse pipeline** (its own enrollment service, scorer, tables) — rejected;
  it violates the reuse constraint and would drift from the keystroke definitions. The
  `modality` parameter generalizes the existing lifecycle with defaults, touching no
  keystroke call site.
- **Token in the WS query string** — rejected; it lands in URLs, proxies, and logs. The
  subprotocol / Authorization header keeps it out of the URL.
- **Lock on a single anomalous window** — rejected; too flappy. The EWMA requires a
  sustained spike, trading a few hundred ms of latency for far fewer false locks.
- **Per-window risk_events rows** — rejected; floods the evaluation dataset and persists a
  biometric-derived score stream. Only the lock decision is logged.
- **Client-side scoring of windows** — rejected by ADR-0002 (the client must not judge
  itself); the server scores authoritatively.
