# ADR-0009 — Behavioral Feature Schema, Position-Indexed Capture & Enrollment Lifecycle

- Status: **Accepted**
- Context: Milestone 6 (keystroke capture + enrollment). First behavioral code.
- Related: `PROJECT.md` §1, §4.4, §5, §6; ADR-0002 (baselines server-side, model-only,
  encrypted at rest); ADR-0005 (AEAD wire format & domain separation);
  `migrations/0002_enrollment_feature_schema_version.sql`.

## Context

The adaptive-auth engine needs a per-user behavioral baseline of how the master password is
typed. M6 builds the **enrollment** half: capture keystroke timing, accumulate samples, fit a
baseline, store it model-only and encrypted, purge the raw samples. Scoring is M7.

This forces several decisions: what a feature vector **is**, how it is captured **without ever
seeing the password characters** (extending Phase-1 zero-knowledge into behavior), where the
single extractor definition lives, how the lifecycle moves from samples → model, and how to make
the ~10-sample covariance invertible (M7's Mahalanobis distance needs the inverse).

## Decision

### 1. Feature schema — position-indexed, durations only (versioned)

A sample is the standard CMU keystroke-dynamics feature set, **indexed by keystroke POSITION,
never character identity**:

```
[ hold_1 … hold_n , DD_1 … DD_(n-1) , UD_1 … UD_(n-1) ]      dimension = 3n − 2
  hold_i = up_i − down_i           (dwell time of key i)
  DD_i   = down_{i+1} − down_i     (down-down latency)
  UD_i   = down_{i+1} − up_i       (up-down latency; may be negative under rollover)
```

All values are **milliseconds**. The vector dimension is parametric in the user's password
length (a user's dimension = `3 · passwordLength − 2`). `FEATURE_SCHEMA_VERSION = 1` is stamped on
every sample and on the fitted baseline; bumping it invalidates older in-progress enrollments.

The schema, the version, and the **single extractor** live in `@cerberus/shared-types`
(`behavioral.ts`). The SAME `extractFeatureVector` runs for live capture (webview) and CMU
ingestion (server) — there is exactly one definition, so the two can never drift.

### 2. The position-indexed privacy model (the heart of the milestone)

The behavioral path **must not see, store, transmit, or log the password characters.** This is
enforced **structurally**, not by discipline:

- `KeystrokeTiming` and the recorder's API carry only `down`/`up` timestamps — there is no field
  that can hold a key or character. The capture handler reads only `event.repeat` and the clock;
  it never accesses `event.key`/`code`/`keyCode`. A test proves this with an event whose `key`
  getter throws if touched.
- The wire DTO is `number[]`; zod strips unknown keys, so a client cannot smuggle a character
  field alongside the vector. The stored sample is numbers and nothing else (asserted in tests).
- The password value continues to flow **only** to the Rust crypto core for key derivation
  (unchanged, still zeroized). The timing path derives purely from event timestamps and is a
  **separate data path**.

Feature vectors are biometric-adjacent (PROJECT.md §5): never logged beside identity, never
returned raw over the API (the status endpoint returns only counts), encrypted at rest, purged
on activation.

### 3. Capture & keyup↔keydown matching

Keyups are matched to keydowns in **FIFO press order**. This is exact for deliberate, in-order
release (the normal case, including ordinary rollover where keys are released in press order).
Under rare *nested* release (press a, press b, release b, release a) the hold/UD attribution is
approximate; the baseline statistics absorb that noise. Auto-repeat keydowns are dropped. Samples
are submitted **only after a successful login**; a failed attempt's capture is discarded.

### 4. Enrollment lifecycle (server, authoritative)

`accumulate → fit → encrypt → purge → activate`, serialized per user:

1. Authenticated `POST /enrollment/samples` buffers a sample in `enrollment_samples` (ephemeral).
   `GET /enrollment/status` returns `{ status, samplesCollected, samplesRequired, … }`.
2. When the buffer reaches `MIN_ENROLLMENT_SAMPLES` (config, default **10**, env-tunable; no magic
   number, PROJECT.md §4.4), the server fits the baseline (mean + covariance), stores it
   **model-only** and **encrypted at rest** in `behavioral_baselines`, marks it `active`, and
   **purges** that user's `enrollment_samples` rows (data minimization, ADR-0002).
3. All of step 2 runs inside one transaction holding a per-user `pg_advisory_xact_lock`, so a fit
   is atomic and concurrent submits cannot double-fit. After activation, further submits are
   idempotent (nothing is re-buffered). A mid-enrollment dimension change is rejected (the client
   resets) so a batch never mixes password lengths.

### 5. Covariance regularization — Ledoit-Wolf shrinkage + diagonal-loading ridge

With ~10 samples and a 31-dim vector the sample covariance has rank ≤ N−1 < d and is **singular**
(no inverse). We apply **Ledoit-Wolf shrinkage toward a scaled-identity target** (Ledoit & Wolf,
2004): `Σ* = (1−ρ)·S + ρ·μ·I`, where `μ = trace(S)/d` (average variance) and `ρ ∈ [0,1]` is
computed analytically from the data — a provably well-conditioned estimator with no hand-tuned
intensity (so no magic number). A tiny **diagonal-loading ridge** (`COVARIANCE_RIDGE`, named
config) is then added as a numerical floor guaranteeing strict positive-definiteness even in
degenerate inputs (e.g. all samples identical). The result is symmetric positive-definite, hence
invertible — verified by a successful Cholesky decomposition and by `Σ·Σ⁻¹ ≈ I` in tests. This is
what M7's Mahalanobis distance consumes.

### 6. At-rest encryption of the model

The fitted model is serialized to JSON (means + covariance + regularization metadata; **no raw
samples**) and encrypted with **AES-256-GCM** (AEAD only, PROJECT.md §3) under a **server-managed
key separate from any user vault key**, with a fresh 96-bit IV per op and output `ciphertext‖tag`
(ADR-0005 layout). The **AAD binds the blob to the pseudonymous `user_id`**, so a stolen blob
cannot be decrypted under another id nor swapped between users. The key is loaded from
`BASELINE_ENC_KEY`; production refuses to start with the dev default (fail closed). The server
must be able to decrypt to score in M7 — the documented ADR-0002 limitation, not a new leak.

## Consequences

- New shared module `@cerberus/shared-types/behavioral` (schema + extractor + DTOs); new server
  `risk/` modules (named config, baseline fit, CMU loader), `services/{enrollment,baseline-crypto}`,
  two repositories, and `routes/enrollment`. New migration `0002` adds
  `enrollment_samples.feature_schema_version`.
- The CMU loader proves the pipeline on the published benchmark (`DSL-StrongPasswordData.csv`)
  using the same extractor; a per-subject baseline fit is a sanity fixture. No FAR/FRR/EER here —
  that is M7. The loader is reusable for the §6 evaluation scripts.
- Phase-1 zero-knowledge now extends into behavior: the server learns *how* a user types but never
  *what* they type.

## Alternatives considered

- **Capturing character→timing maps** (per-key, not per-position) — rejected; it would put
  character identity into the behavioral path, breaking the privacy rule.
- **A fixed shrinkage intensity** — workable but reintroduces a magic number; Ledoit-Wolf computes
  ρ from the data and is citable for the thesis. The ridge floor is the only named constant.
- **Reusing the Rust XChaCha20-Poly1305 path for the model** — rejected; baseline encryption is a
  *server* operation with a *server* key (the server must decrypt to score). AES-256-GCM via Node
  is the right tool and is still AEAD with domain-separating AAD.
- **On-device baseline storage** — already rejected in ADR-0002 (tamper-resistance).
