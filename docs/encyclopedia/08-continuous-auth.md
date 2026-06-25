# 08 — Continuous authentication: ongoing mouse assessment and auto-lock

> Part of the Project Cerberus encyclopedia. See the [index](00-index.md) and the
> [glossary](13-glossary.md). Sibling docs you'll want open: the
> [behavioral engine](06-behavioral-engine.md) (the scorer and enrollment lifecycle this
> reuses), the [decision and policy](07-decision-and-policy.md) doc (the login-time analogue),
> and [vault and sync](05-vault-and-sync.md) (the vault lock state this drives).

---

## 1. In plain English

Logging in proves who you are **once**, at the door. But what if you walk away from your
unlocked vault and someone else sits down? Or your session is hijacked after you got in?
Cerberus keeps watching **after** the door opens. While the vault is unlocked, the desktop
app quietly measures *how you move the mouse* — speed, acceleration, how sharply you turn,
how often you click and pause — and streams a compact summary of each short burst of
movement to the server. The server compares each burst to **your** normal mouse style. If
the movement starts looking persistently unlike you, the server **locks the vault** and
kicks you back to the unlock screen. This is "continuous authentication": authentication
that never stops for the duration of a session.

Two ideas make this safe rather than annoying. First, a single weird burst can't lock you
out — the server keeps a *running average* (an EWMA, explained below) that only crosses the
panic line if the weirdness is *sustained*. Second, if the system has never learned your
mouse style yet (a new user), it scores **nothing** and locks **nothing** — it just quietly
collects data until it has enough to build your profile. The whole thing reuses the exact
same statistical scorer and enrollment machinery the login keystroke check uses; mouse is
simply the "second modality" plugged into the same pipeline.

Key term up front: **EWMA** = *Exponentially-Weighted Moving Average*, a running average
that weights recent observations more heavily and lets old ones fade away. We define it
precisely in [section 6](#6-the-ewma-the-running-average-that-forgets-gently).

---

## 2. Where it lives

```
cerberus/
├── packages/shared-types/src/
│   └── mouse.ts                         # mouse feature schema + extractor + WS message contract
├── apps/desktop/src/
│   ├── lib/
│   │   ├── mouse-capture.ts             # client: capture pointer samples → sliding-window feature vectors
│   │   └── ws.ts                        # client: the continuous-auth WebSocket client
│   └── features/vault/VaultView.tsx     # client: wires capture + WS while the vault is unlocked
└── apps/server/src/
    ├── risk/continuous-auth.ts          # PURE: EWMA update + spike test
    ├── services/continuous-auth.ts      # per-session evaluator: cold-start vs score, folds into EWMA
    ├── ws/index.ts                      # WebSocket transport: upgrade auth, per-window handling, lock
    └── repositories/risk-events.ts      # persists the lock decision (the only thing stored)
```

Authoritative decision: [ADR-0013](../../docs/adr/0013-continuous-auth-mouse-dynamics.md).

This doc covers the *transport and in-session loop*. The mouse **feature extractor** and the
shared **Mahalanobis→χ² scorer** are documented in depth in the
[behavioral engine](06-behavioral-engine.md) and the
[algorithms deep-dive](14-algorithms-deep-dive.md); here we explain them only as far as the
continuous loop uses them.

---

## 3. File-by-file

### [`packages/shared-types/src/mouse.ts`](../../packages/shared-types/src/mouse.ts)
**Job:** the single source of truth for (a) the 9-number mouse feature vector and how to
compute it, and (b) the WebSocket message shapes — so the desktop client and the server can
never drift apart.

Key exports:
- `MOUSE_FEATURE_SCHEMA_VERSION = 1` ([mouse.ts:18](../../packages/shared-types/src/mouse.ts)) — stamped on every streamed window and on each fitted baseline. Bumping it invalidates older in-progress mouse enrollments. Independent of the keystroke `FEATURE_SCHEMA_VERSION`.
- `MOUSE_FEATURE_DIMENSION = 9` ([mouse.ts:25](../../packages/shared-types/src/mouse.ts)) — fixed, unlike keystroke (whose dimension grows with password length). Because it's fixed, the Mahalanobis scorer is reused **unchanged**.
- `MOUSE_FEATURE_LABELS` ([mouse.ts:28-38](../../packages/shared-types/src/mouse.ts)) — human-readable names for the 9 slots: `meanVelocity, stdVelocity, meanAbsAcceleration, stdAbsAcceleration, meanAbsCurvature, stdAbsCurvature, clickRate, meanClickDuration, pauseRate`.
- `MOUSE_WINDOW_SIZE = 32`, `MOUSE_WINDOW_STEP = 16` ([mouse.ts:45-46](../../packages/shared-types/src/mouse.ts)) — sliding-window geometry (50% overlap).
- `MIN_MOUSE_SAMPLES = 3` ([mouse.ts:49](../../packages/shared-types/src/mouse.ts)) — need ≥3 points to compute acceleration + curvature.
- `MOUSE_PAUSE_THRESHOLD_MS = 120` ([mouse.ts:52](../../packages/shared-types/src/mouse.ts)) — an inter-event gap longer than this counts as a deliberate pause.
- `extractMouseWindowFeatures(samples)` ([mouse.ts:104](../../packages/shared-types/src/mouse.ts)) — the pure, deterministic extractor (covered in [section 5](#5-the-feature-extractor-from-pointer-trail-to-9-numbers)).
- `MouseSample` ([mouse.ts:63-69](../../packages/shared-types/src/mouse.ts)) — one captured event: `{ x, y, t, kind: 'move' | 'down' | 'up' }`. **Note the absence of any content field** — there is structurally nowhere to store *what* was clicked or typed (the privacy rule).
- Zod schemas + constants for the wire contract: `MouseFeatureVectorSchema`, `MouseWindowMessageSchema`, `ContinuousAuthClientMessageSchema`, `ContinuousAuthServerMessageSchema`, `CONTINUOUS_AUTH_WS_PATH = '/ws/continuous-auth'`, `CONTINUOUS_AUTH_SUBPROTOCOL = 'cerberus.continuous-auth.v1'`, and `bearerSubprotocol(token)` ([mouse.ts:197-257](../../packages/shared-types/src/mouse.ts)).

**Imported by:** the desktop capture/WS client and the server service/WS/scoring. **Gotcha:**
`MouseFeatureVectorSchema` enforces `.length(9)` and a finite-range refine
([mouse.ts:197-202](../../packages/shared-types/src/mouse.ts)) — a malformed feature array is
rejected at the boundary on both ends.

### [`apps/desktop/src/lib/mouse-capture.ts`](../../apps/desktop/src/lib/mouse-capture.ts)
**Job:** listen to pointer events, accumulate samples, and emit a 9-number feature vector
once per sliding window.

- `MouseWindowAggregator` ([mouse-capture.ts:25](../../apps/desktop/src/lib/mouse-capture.ts)) — buffers `MouseSample`s; `add(sample)` returns a feature vector when the buffer fills `windowSize`, then slides forward by `step`; `reset()` clears the buffer.
- `attachMouseCapture(target, onWindow, now?)` ([mouse-capture.ts:73](../../apps/desktop/src/lib/mouse-capture.ts)) — attaches `mousemove`/`mousedown`/`mouseup` listeners, feeds samples to the aggregator, calls `onWindow(features)` per completed window, and returns a detach function.
- `PointerProbeEvent` ([mouse-capture.ts:54-57](../../apps/desktop/src/lib/mouse-capture.ts)) — the minimal event shape the module reads: **only `clientX` and `clientY`**. There is no `target`, no element reference, no content.

**Imported by:** [`VaultView.tsx`](../../apps/desktop/src/features/vault/VaultView.tsx) and the
inspector's `RiskDashboard.tsx`. **Gotcha:** the handlers read only `clientX/clientY` plus the
clock — this is the *structural* enforcement of the privacy rule, not a runtime filter.

### [`apps/desktop/src/lib/ws.ts`](../../apps/desktop/src/lib/ws.ts)
**Job:** the browser-side WebSocket client — opens the authenticated stream, sends windows,
and reacts to server commands.

- `openContinuousAuth(token, handlers, WebSocketCtor?)` ([ws.ts:62](../../apps/desktop/src/lib/ws.ts)) — opens the socket offering two subprotocols, validates every incoming message with `ContinuousAuthServerMessageSchema`, and returns a `{ sendWindow, close }` client.
- `continuousAuthWsUrl()` ([ws.ts:50](../../apps/desktop/src/lib/ws.ts)) — derives the `ws(s)://…/ws/continuous-auth` URL from the API base origin (https → wss).
- `ContinuousAuthHandlers` ([ws.ts:32-40](../../apps/desktop/src/lib/ws.ts)) — `onLocked()` (required) and `onScore?(score)` (optional, only ever fired for a step-up-confirmed session).

**Imported by:** `VaultView.tsx` (uses only `onLocked`) and `RiskDashboard.tsx` (uses both).
**Gotcha:** `sendWindow` is a no-op unless `socket.readyState === OPEN`
([ws.ts:88-90](../../apps/desktop/src/lib/ws.ts)) — windows captured before the handshake
completes are silently dropped, which is fine (the server is the authority; a dropped window
can't grant access).

### [`apps/server/src/risk/continuous-auth.ts`](../../apps/server/src/risk/continuous-auth.ts)
**Job:** the pure math — the EWMA update and the spike test. No I/O, no state.

- `updateInSessionComposite(prev, subScore, alpha)` ([continuous-auth.ts:17](../../apps/server/src/risk/continuous-auth.ts)) — `clamp01(α·subScore + (1−α)·prev)`.
- `isSpike(composite, config)` ([continuous-auth.ts:22](../../apps/server/src/risk/continuous-auth.ts)) — `composite >= config.spikeThreshold` (note `>=`: ties **escalate**, i.e. fail closed).

**Imported by:** the continuous-auth service. **Gotcha:** this is the in-session analogue of
the login *combiner* (see [decision and policy](07-decision-and-policy.md)) — but for a single
in-session signal, so there is no multi-signal weighting here, just smoothing + a band.

### [`apps/server/src/services/continuous-auth.ts`](../../apps/server/src/services/continuous-auth.ts)
**Job:** per-connection evaluator. Decides, per window, whether to **buffer** (cold-start) or
**score** (active baseline), folds scores into the EWMA, and reports the spike verdict.

- `createContinuousAuthService(deps)` ([continuous-auth.ts:57](../../apps/server/src/services/continuous-auth.ts)) — wires the **reused** enrollment service (parameterized `modality: 'mouse'`) and scoring service (`modality: 'mouse'`).
- `newSession()` → `SessionEvaluator` ([continuous-auth.ts:73](../../apps/server/src/services/continuous-auth.ts)) — closes over a mutable `composite` (starts at 0) and exposes `evaluate(userId, window)`.
- `WindowEvaluation` ([continuous-auth.ts:36-49](../../apps/server/src/services/continuous-auth.ts)) — `{ scored, spike, subScore, composite, threshold, reason }`.

**Imported by:** the WS transport and the server bootstrap. **Gotcha:** the *reason* it
attaches is the scorer's `keystroke.reason` field ([continuous-auth.ts:109,120](../../apps/server/src/services/continuous-auth.ts)) — confusingly named, but that field carries the
*modality-agnostic* score/distance metadata; the mouse modality reuses the same scorer
struct. It is score/distance metadata, **never** the raw vector.

### [`apps/server/src/ws/index.ts`](../../apps/server/src/ws/index.ts)
**Job:** the transport. Authenticates the HTTP upgrade, serializes windows through the
per-session evaluator, gates the score telemetry, and performs the lock.

- `attachContinuousAuthWebSocket(server, deps)` ([ws/index.ts:87](../../apps/server/src/ws/index.ts)) — registers the `upgrade` handler; returns the `WebSocketServer`.
- `extractToken(req)` ([ws/index.ts:40](../../apps/server/src/ws/index.ts)) — header first (`Authorization: Bearer …`), then `bearer.<token>` subprotocol.
- `onConnection` ([ws/index.ts:139](../../apps/server/src/ws/index.ts)) — one evaluator per connection; chains window handling so windows process strictly in order.
- `handleWindow` ([ws/index.ts:148](../../apps/server/src/ws/index.ts)) — parse → evaluate → (gated) send score → on spike: write `risk_events`, `markLocked`, send `locked`, close.

**Imported by:** the server bootstrap ([`index.ts:33`](../../apps/server/src/index.ts)) and the
WS test. **Gotcha:** `handleProtocols` echoes *only* the main subprotocol and never the
`bearer.<token>` entry ([ws/index.ts:96-98](../../apps/server/src/ws/index.ts)) — the token is
auth material, not a negotiated protocol.

### [`apps/server/src/repositories/risk-events.ts`](../../apps/server/src/repositories/risk-events.ts)
**Job:** persist risk evaluations. For continuous auth, only the **lock decision** is written
(not every window). `insert(...)` ([risk-events.ts:103](../../apps/server/src/repositories/risk-events.ts)) — parameterized, user-scoped. Stores scores, structured reasons, coarse geo, truncated IP — never raw timings/coordinates/IPs. Covered fully in the [database doc](10-database.md).

**Skipped as trivial here:** the test files (`*.test.ts`) — they assert the behaviors described
below but add no production logic; and `VaultView.tsx` beyond its WS-wiring `useEffect`, which is
the [frontend doc](11-frontend.md)'s territory.

---

## 4. How it works — follow the data, in run order

Plain English: the client captures mouse bursts and ships a summary of each over an
authenticated socket; the server scores each summary against your profile, smooths the
scores, and locks if the smoothed score crosses a line.

```mermaid
sequenceDiagram
    participant U as User (mouse)
    participant C as Desktop client
    participant W as WS transport (ws/index.ts)
    participant E as Per-session evaluator
    participant DB as PostgreSQL

    Note over C,W: HTTP upgrade — token via bearer.&lt;t&gt; subprotocol verified vs active session
    U->>C: mousemove / down / up
    C->>C: aggregate 32 samples → 9-dim feature vector
    C->>W: { type: mouse_window, featureSchemaVersion, features[9] }
    W->>E: evaluate(userId, window)
    alt no active mouse baseline
        E->>DB: submitSample (buffer toward baseline)
        E-->>W: scored=false, spike=false (cold-start neutral)
    else active baseline
        E->>E: scoreActive → sub-score; composite = EWMA(prev, sub)
        E-->>W: scored=true, composite, spike?
    end
    opt session is step-up-confirmed
        W->>C: { type: score, composite, threshold, scored }
    end
    alt spike (composite >= 0.85)
        W->>DB: insert risk_events (policy_band=deny, action=session_locked)
        W->>DB: sessions.markLocked(session.id)
        W->>C: { type: locked, reason: risk }
        W->>C: close(1000)
        C->>C: lock() → zeroize keys → unlock screen
    end
```

### Step 0 — capture (client)
While the vault is unlocked, [`VaultView.tsx`](../../apps/desktop/src/features/vault/VaultView.tsx)
runs a `useEffect` ([VaultView.tsx:719-744](../../apps/desktop/src/features/vault/VaultView.tsx))
that opens the WS client and calls `attachMouseCapture(window, (features) => client.sendWindow(features))`.
Every `mousemove`/`mousedown`/`mouseup` becomes a `MouseSample` `{ x, y, t, kind }`. The
`MouseWindowAggregator` buffers them; when the buffer reaches `MOUSE_WINDOW_SIZE = 32` samples it
extracts a feature vector via `extractMouseWindowFeatures`, then slides forward by
`MOUSE_WINDOW_STEP = 16` ([mouse-capture.ts:34-45](../../apps/desktop/src/lib/mouse-capture.ts)).
Because consecutive windows overlap by `32 − 16 = 16` samples (50%), a developing spike is
re-evaluated every **16 samples**, not every 32 — a spike is caught within one *step*.

### Step 1 — upgrade & authenticate (server)
The browser WebSocket can't set an `Authorization` header, so the client offers two
subprotocols: the main `cerberus.continuous-auth.v1` and `bearer.<token>`
([ws.ts:67-70](../../apps/desktop/src/lib/ws.ts)). On `server.on('upgrade')`
([ws/index.ts:100](../../apps/server/src/ws/index.ts)) the transport:
1. rejects any path other than `/ws/continuous-auth` with `socket.destroy()` ([ws/index.ts:108-111](../../apps/server/src/ws/index.ts)) — no other WS endpoints exist;
2. extracts the token (header, else subprotocol) ([ws/index.ts:40-61](../../apps/server/src/ws/index.ts)); a missing token → `401` + destroy ([ws/index.ts:113-117](../../apps/server/src/ws/index.ts));
3. hashes the token (`hashSessionToken`) and looks up an **active** session ([ws/index.ts:119-120](../../apps/server/src/ws/index.ts)); no active session → reject (**fail closed**) ([ws/index.ts:122-125](../../apps/server/src/ws/index.ts)).

Only then does it `handleUpgrade` and hand off to `onConnection`. This is the security crux: a
revoked or locked session token stops authenticating the socket too, because the lookup is
`findActiveByTokenHash`.

### Step 2 — per-connection ordering
`onConnection` creates **one** `SessionEvaluator` per socket and a promise `chain`
([ws/index.ts:140-145](../../apps/server/src/ws/index.ts)). Each incoming message extends the
chain (`chain = chain.then(() => handleWindow(...))`), so windows are processed **strictly in
order**. Why this matters: the EWMA composite is *mutable per connection*; if two windows scored
concurrently they'd race on `composite` and the smoothing would be wrong (and possibly miss a
spike).

### Step 3 — parse the window
`handleWindow` parses the frame with `ContinuousAuthClientMessageSchema.parse(...)` inside a
try/catch ([ws/index.ts:155-160](../../apps/server/src/ws/index.ts)). A malformed/untrusted
frame is **ignored** (return), never crashes the server. Valid frames are
`{ type: 'mouse_window', featureSchemaVersion, features[9] }`.

### Step 4 — evaluate: cold-start vs score
`evaluator.evaluate(session.userId, message)` ([services/continuous-auth.ts:79](../../apps/server/src/services/continuous-auth.ts)):
- It looks up the user's **active mouse baseline** via `findActiveByUser(userId, 'mouse')` ([continuous-auth.ts:84](../../apps/server/src/services/continuous-auth.ts)).
- **No active baseline (cold-start):** it `submitSample`s the window toward the mouse baseline (reusing the enrollment lifecycle) and returns `{ scored: false, spike: false, subScore: null, composite (unchanged), reason: { status: 'enrolling' } }` ([continuous-auth.ts:85-96](../../apps/server/src/services/continuous-auth.ts)). **Nothing is scored, so nothing can lock.** Once `MOUSE_MIN_ENROLLMENT_SAMPLES = 12` windows accumulate, the enrollment service fits + activates the baseline; subsequent windows take the scoring path.
- **Active baseline:** it calls `mouseScoring.scoreActive(userId, sample)` — the **same** Mahalanobis→χ² scorer keystroke login uses ([continuous-auth.ts:98](../../apps/server/src/services/continuous-auth.ts)). If the result isn't `'scored'` (e.g. a dimension/schema mismatch), it leaves the composite untouched and does **not** lock on that one malformed window ([continuous-auth.ts:99-111](../../apps/server/src/services/continuous-auth.ts)); the next valid window resumes. If scored, it folds the sub-score into the EWMA: `composite = updateInSessionComposite(composite, result.behavioralScore, config.ewmaAlpha)` ([continuous-auth.ts:113](../../apps/server/src/services/continuous-auth.ts)) and returns `spike: isSpike(composite, config)`.

### Step 5 — gated score telemetry
Back in `handleWindow`, **only if `session.stepUpConfirmed`** does the server send
`{ type: 'score', composite, threshold, scored }` ([ws/index.ts:167-175](../../apps/server/src/ws/index.ts)). This is the live feed for the Risk Inspector's session monitor (see
[frontend doc](11-frontend.md)). A normal session **never** receives it — so the generic
lock copy is the only thing a normal user ever sees, and no per-window risk score leaks.

### Step 6 — spike → lock (fail closed)
If `!result.spike`, `handleWindow` returns ([ws/index.ts:177-179](../../apps/server/src/ws/index.ts)). On a spike it does four things in order ([ws/index.ts:181-206](../../apps/server/src/ws/index.ts)):
1. **Record** a `risk_events` row: `signals.mouse = { modality, score, reason }`, `signals.continuousAuth = { composite, action: 'session_locked' }`, `behavioralScore = subScore`, `compositeScore = composite`, `policyBand = 'deny'`, `actionTaken = 'session_locked'`, geo/IP `null`, `outcome = 'session_locked'`.
2. **`markLocked(session.id)`** — the session row is flipped to locked, so the bearer token stops authenticating everywhere (HTTP and future WS upgrades).
3. **Send `{ type: 'locked', reason: 'risk' }`** — a generic category, no signal/score detail.
4. **`close(1000, 'locked')`** — close the socket cleanly.

### Step 7 — client locks
On the client, `openContinuousAuth`'s message handler validates the frame and, for `locked`,
calls `handlers.onLocked()` ([ws.ts:79-83](../../apps/desktop/src/lib/ws.ts)). In `VaultView`,
`onLocked` guards against double-fire, then `void lock()` (zeroize keys via the Rust lock path)
and finally `onLock('risk')` to return to the unlock screen
([VaultView.tsx:725-735](../../apps/desktop/src/features/vault/VaultView.tsx)). Re-entry means a
fresh **login** risk evaluation — a mid-session spike costs the user access until they re-prove.
See the vault lock state machine in [vault and sync](05-vault-and-sync.md#vault-state).

---

## 5. The feature extractor: from pointer trail to 9 numbers

> Four-pass treatment of `extractMouseWindowFeatures`
> ([mouse.ts:104-188](../../packages/shared-types/src/mouse.ts)). The scorer itself
> (Mahalanobis→χ²) is in the [algorithms deep-dive](14-algorithms-deep-dive.md); here is just the
> input it consumes.

**(a) Intuition.** Everyone moves a mouse with a personal "handwriting": some people swoop fast
and overshoot, others creep and correct. We can't store the raw squiggle (that's
biometric-adjacent and privacy-sensitive), so we summarize each 32-event burst into 9 plain
statistics that capture the *style* without the *content*.

**(b) Mechanism.** For consecutive samples we compute per-segment **velocity** (`dist/dt`),
then **acceleration** (absolute change in velocity), then **curvature** (absolute turning angle
between consecutive segment directions, wrapped to `[0, π]` so a U-turn reads as a big turn).
Clicks pair each `down` with the next `up` (duration = release − press). A **pause** is any gap
`> MOUSE_PAUSE_THRESHOLD_MS (120 ms)`. Rates are normalized per second over the window's
wall-clock span. The 9 outputs are mean+std of velocity, mean+std of acceleration, mean+std of
curvature, click rate, mean click duration, pause rate.

**(c) In code.** Velocities at [mouse.ts:113-128](../../packages/shared-types/src/mouse.ts);
accelerations at [mouse.ts:135-142](../../packages/shared-types/src/mouse.ts); curvature with the
`> π` wrap at [mouse.ts:146-158](../../packages/shared-types/src/mouse.ts); click pairing at
[mouse.ts:161-170](../../packages/shared-types/src/mouse.ts); the per-second normalization at
[mouse.ts:172-175](../../packages/shared-types/src/mouse.ts); the final 9-vector at
[mouse.ts:177-187](../../packages/shared-types/src/mouse.ts). Throws below `MIN_MOUSE_SAMPLES = 3`
([mouse.ts:105-107](../../packages/shared-types/src/mouse.ts)) — a too-small window never yields
a misleading vector (fail closed at the capture boundary). `std` is **population** std
([mouse.ts:82-93](../../packages/shared-types/src/mouse.ts)).

**(d) Worked example.** Three samples, all `move`: `A=(0,0,t=0)`, `B=(3,4,t=10)`,
`C=(3,4,t=20)` (the pointer moves then stops).
- Segment A→B: `dist = √(3²+4²) = 5`, `dt = 10` → velocity `0.5 px/ms`; angle `atan2(4,3) ≈ 0.927 rad`.
- Segment B→C: `dist = 0`, `dt = 10` → velocity `0`; **no angle** (dist 0, so it's skipped at [mouse.ts:129-131](../../packages/shared-types/src/mouse.ts)).
- velocities = `[0.5, 0]` → mean `0.25`, std `0.25`.
- accelerations = `[|0 − 0.5|] = [0.5]` → mean `0.5`, std `0` (only one value).
- curvatures = `[]` (need ≥2 segment angles) → mean `0`, std `0`.
- no clicks → clickRate `0`, meanClickDuration `0`.
- window span `= 20 ms` → `perSecond = 1000/20 = 50`; no pauses (gaps are 10 ms < 120) → pauseRate `0`.
- Result: `[0.25, 0.25, 0.5, 0, 0, 0, 0, 0, 0]`. That 9-vector is what gets streamed.

---

## 6. The EWMA: the running average that forgets gently

> Four-pass treatment of `updateInSessionComposite`
> ([risk/continuous-auth.ts:17-19](../../apps/server/src/risk/continuous-auth.ts)).

**(a) Intuition.** Imagine grading someone's "anomaly level" not on their latest single move,
but on a rolling impression that gives the newest move the most weight while letting old moves
fade. One twitchy window barely nudges the impression; a *string* of twitchy windows drags it up
fast. "Exponentially-weighted" means each older observation's influence shrinks by a constant
factor as newer ones arrive — the past is forgotten *gently*, never abruptly and never fully
remembered.

**(b) Mechanism / math.** With smoothing factor `α ∈ (0,1]`:

```
compositeₜ = clamp01( α · subScoreₜ + (1 − α) · compositeₜ₋₁ ),   composite₀ = 0
```

`clamp01` keeps it in `[0,1]`. A higher `α` is *more reactive* (weights the newest window more);
a lower `α` is *smoother* (more inertia). Expanding the recursion shows the exponential decay: the
window `k` steps ago contributes `α·(1−α)ᵏ`.

**(c) In code.** `clamp01(alpha * subScore + (1 - alpha) * prev)`
([continuous-auth.ts:18](../../apps/server/src/risk/continuous-auth.ts)). Starts from `0` (a
fresh, unlocked session is neutral — [services/continuous-auth.ts:74](../../apps/server/src/services/continuous-auth.ts)). The **real parameter** here is `ewmaAlpha = 0.5` and the spike line
is `spikeThreshold = 0.85` (`DEFAULT_CONTINUOUS_AUTH_CONFIG`,
[risk/config.ts:354-358](../../apps/server/src/risk/config.ts)); both are env-overridable
*outside production only* (`config.ts:259-262`). `isSpike` uses `>=`
([continuous-auth.ts:22-24](../../apps/server/src/risk/continuous-auth.ts)) so a tie escalates.

**(d) Worked example (α = 0.5, threshold = 0.85), starting composite = 0.**

*Scenario A — one anomalous window, then calm (a stray flick):*

| window | subScore | composite = 0.5·sub + 0.5·prev | spike (≥0.85)? |
|---|---|---|---|
| 1 | 0.95 | 0.5·0.95 + 0.5·0 = **0.475** | no |
| 2 | 0.10 | 0.5·0.10 + 0.5·0.475 = **0.2875** | no |
| 3 | 0.10 | 0.5·0.10 + 0.5·0.2875 ≈ **0.194** | no |

A single hot window peaks at 0.475 — well under 0.85 — and decays away. **No spurious lock.**

*Scenario B — a sustained takeover (every window screams anomaly):*

| window | subScore | composite | spike? |
|---|---|---|---|
| 1 | 0.95 | **0.475** | no |
| 2 | 0.95 | 0.5·0.95 + 0.5·0.475 = **0.7125** | no |
| 3 | 0.95 | 0.5·0.95 + 0.5·0.7125 ≈ **0.831** | no |
| 4 | 0.95 | 0.5·0.95 + 0.5·0.831 ≈ **0.891** | **YES → lock** |

Sustained anomaly crosses 0.85 on the **4th** scored window — a few hundred milliseconds of
latency in exchange for far fewer false locks. This is exactly the trade-off ADR-0013 chose over
"lock on a single anomalous window" (rejected as too flappy).

---

## 7. Cold-start: never a spurious lock before the baseline exists

Plain English: a brand-new user (or a user who has never built a mouse profile) has no model to
be compared against. Rather than guess — and risk locking a legitimate person out — the system
**scores nothing** and just collects windows until it has enough.

Mechanically, every window first checks `findActiveByUser(userId, 'mouse')`
([services/continuous-auth.ts:84](../../apps/server/src/services/continuous-auth.ts)). With no
active baseline, the window is `submitSample`d toward enrollment and the evaluator returns
`scored: false, spike: false`, leaving the composite at its neutral `0`
([continuous-auth.ts:85-96](../../apps/server/src/services/continuous-auth.ts)). Because nothing
is scored, the EWMA never moves, so `isSpike` is never true — **a cold-start session is
structurally unable to lock.** After `MOUSE_MIN_ENROLLMENT_SAMPLES = 12` windows accumulate
([risk/config.ts:337](../../apps/server/src/risk/config.ts)), the reused enrollment lifecycle
fits the model (mean + Ledoit-Wolf-shrunk covariance), encrypts it model-only, purges the raw
windows, and activates — only then do windows take the scoring path. This mirrors the login-time
cold-start rule for keystroke (see [decision and policy](07-decision-and-policy.md)).

> Note: enrollment here happens **over the stream itself** — there is no separate "mouse
> enrollment" UI. The same windows that would be scored are, before activation, the training
> data. ADR-0013 §C.

---

## 8. Modality reuse: the same scorer, the same lifecycle

The defining design constraint of ADR-0013 is **no per-modality duplication**. The continuous-auth
service is built entirely from existing machinery, parameterized:

- **Enrollment** — `createEnrollmentService({ ..., modality: 'mouse', featureSchemaVersion: MOUSE_FEATURE_SCHEMA_VERSION, modelVersion: MOUSE_BASELINE_MODEL_VERSION })` ([services/continuous-auth.ts:61-68](../../apps/server/src/services/continuous-auth.ts)). Same accumulate → fit → encrypt → purge → activate lifecycle as keystroke; the `modality` discriminator (DB migration 0005) keeps the two baselines separate.
- **Scoring** — `createScoringService({ ..., modality: 'mouse' })` ([services/continuous-auth.ts:69](../../apps/server/src/services/continuous-auth.ts)). The identical Mahalanobis→χ² `scoreActive`. Because the mouse vector is a **fixed** 9 dimensions, the scorer needs no changes (unlike the password-length-parametric keystroke vector).
- **The only new in-session code** is the EWMA smoothing + spike band ([risk/continuous-auth.ts](../../apps/server/src/risk/continuous-auth.ts)) — the single-signal in-session analogue of the login combiner.

See the [behavioral engine](06-behavioral-engine.md) for the enrollment lifecycle and the
[algorithms deep-dive](14-algorithms-deep-dive.md) for the scorer internals.

---

## 9. How it connects

**Receives from:**
- the **desktop client** ([VaultView.tsx](../../apps/desktop/src/features/vault/VaultView.tsx)) — streamed `mouse_window` messages while unlocked, authenticated by the session token (from login / step-up; see [decision and policy](07-decision-and-policy.md)).
- the **sessions repository** — `findActiveByTokenHash` (upgrade auth) and `markLocked` (the lock); see [database](10-database.md) and [server and API](09-server-and-api.md).
- the **behavioral engine** — the reused enrollment + scoring services and the encrypted mouse baseline.

**Hands to:**
- the **client** — `{ type: 'locked', reason: 'risk' }` (every session) and `{ type: 'score', … }` (step-up-confirmed sessions only).
- the **`risk_events` table** — exactly one row per lock decision (the evaluation dataset; see [database](10-database.md)).
- the **vault state machine** — on lock, the client zeroizes keys and returns to the unlock screen, re-running the full login risk evaluation on re-entry ([vault and sync](05-vault-and-sync.md#vault-state)).

---

## 10. Gotchas & invariants

1. **Fail closed at every fork.** Bad/absent token at upgrade → `401`/destroy ([ws/index.ts:113-125](../../apps/server/src/ws/index.ts)); a tie at the threshold escalates (`>=`, [continuous-auth.ts:23](../../apps/server/src/risk/continuous-auth.ts)); a malformed window is dropped, not crashed ([ws/index.ts:155-160](../../apps/server/src/ws/index.ts)).
2. **Fail-*safe*, not fail-open, on transport loss.** If the stream dies, the client just stops streaming ([ws.ts:56-61](../../apps/desktop/src/lib/ws.ts)). Losing the stream cannot *grant* access (the server is the authority and access was already granted at login); but note it also means a real spike that never reaches the server can't be reported. ADR-0013 §G calls this fail-safe.
3. **The server is authoritative; the client never judges itself.** The client only captures, streams, and obeys `locked` (ADR-0002, ADR-0013 §G). It does not compute or send a verdict.
4. **No raw biometrics persisted, anywhere.** Capture has structurally no content field; only the 9-number aggregate is streamed; only the fitted model is stored; and only the lock *decision* (with score/reason metadata) lands in `risk_events` — never the per-window score stream ([ADR-0013 Consequences](../../docs/adr/0013-continuous-auth-mouse-dynamics.md)).
5. **Score telemetry is strictly gated.** Only `session.stepUpConfirmed` sessions receive `score` messages ([ws/index.ts:167](../../apps/server/src/ws/index.ts)). This protects the no-risk-detail copy rule for normal users (PROJECT.md §5; ADR-0012).
6. **Generic lock copy only.** The `locked` reason is the literal `'risk'` ([mouse.ts:231](../../packages/shared-types/src/mouse.ts)) — it never names the signal, score, device, or location.
7. **Strict per-connection ordering is load-bearing.** The EWMA composite is mutable; windows must be serialized ([ws/index.ts:142-145](../../apps/server/src/ws/index.ts)) or the smoothing races.
8. **`markLocked` invalidates the token everywhere.** Because upgrade auth (and HTTP auth) look up *active* sessions by token hash, locking the session closes the door on every transport at once — not just this socket.
9. **Cold-start cannot lock — by construction.** The composite never leaves `0` until a baseline activates ([continuous-auth.ts:85-96](../../apps/server/src/services/continuous-auth.ts)).
10. **`reason` field naming is a reuse artifact.** The scorer's struct field is called `keystroke.reason` even for the mouse modality ([continuous-auth.ts:109,120](../../apps/server/src/services/continuous-auth.ts)); it carries modality-agnostic score/distance metadata, not keystroke data and not the raw vector. Worth knowing when reading the `signals` JSON of a `session_locked` `risk_events` row.

No TODOs or stubs appear in the in-scope continuous-auth files — the loop is fully wired
(server bootstrap → upgrade → evaluate → lock; client capture → stream → lock). The only
honest caveat is the fail-safe-on-disconnect property in gotcha 2, which is by design.
