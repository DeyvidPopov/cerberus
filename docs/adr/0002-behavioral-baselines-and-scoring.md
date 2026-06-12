# ADR-0002 — Behavioral Baselines & Anomaly Scoring

- Status: **Accepted**
- Context: gates the behavioral pipeline (Phases 3–4) and the data model.
- Related: `PROJECT.md` §1, §4.4, §5; `docs/threat-model.md` (A4, A6, A8).

## Context

Behavioral authentication needs a per-user baseline (the reference model of keystroke/mouse
dynamics) and a place to score new samples against it. The location of the baseline forces
where scoring runs, and where scoring runs decides what the server must trust. This pits
**privacy** (push behavioral data off the server) against **tamper-resistance** (the entity
making the security decision must be trustworthy).

## Decision

1. **Baselines live server-side**, encrypted at rest, keyed by an opaque pseudonymous user id.
2. **Scoring runs server-side and is authoritative.** The client sends raw telemetry; it never
   reports its own verdict.
3. **Store the model, not the raw signal.** Persist only the fitted statistics needed for
   scoring (per-feature means + covariance matrix for Mahalanobis; fitted model for comparison
   detectors). Raw enrollment captures are discarded once the baseline is active.
4. **Primary detector: Mahalanobis distance** (explainable, clean FAR/FRR/EER). **One-class SVM
   and isolation forest are benchmarked offline** in the evaluation chapter, not deployed live.

## Rationale

For an authentication system, tamper-resistance must win. On-device scoring makes the client
both the authenticated party and its own judge — an attacker on an unknown device controls
their client and can simply report a low score, defeating the system against the exact threat
it exists to stop (A6). That is a hole, not a tradeoff.

The privacy cost of server-side storage is real but bounded and mitigated:

- **Data minimization** — a covariance matrix is far harder to reconstruct into "what the
  person typed" than raw keystroke timing logs.
- **Encryption at rest** protects stolen dumps/backups (A4).
- **Pseudonymization** separates the baseline from identity and credentials.
- _Honest limitation:_ the server decrypts to score, so a malicious operator can observe
  behavioral data at scoring time. This is documented, not hidden.

## Consequences

- The DB schema needs a `behavioral_baselines` table holding an encrypted model blob + version
  - sample count + status, plus an ephemeral enrollment buffer that is purged on activation.
- The evaluation harness runs all three detectors over the same stored feature set, so the
  comparison is apples-to-apples.
- Scoring must be deterministic given the same inputs + seeded model state (reproducibility).

## Alternatives considered

- **On-device only** — rejected; self-reported scores are untrustworthy (A6); cross-device
  sync would require encrypted sync anyway.
- **Server-side plaintext** — rejected; needless privacy cost, undermines the security narrative.
- **Privacy-preserving server-side scoring** (secure enclaves, homomorphic/secure computation)
  — out of scope for this thesis; noted as future work as the principled resolution of the
  privacy-vs-tamper tension.
