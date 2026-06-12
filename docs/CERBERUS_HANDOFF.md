# Project Cerberus — Planning Handoff (resume in a new chat)

Paste this into a new chat to resume planning/review exactly where the previous one ended.
This is the PLANNING state (what's done, decided, next). Durable build rules live in PROJECT.md

- the ADRs in the repo; this document points to them rather than repeating them.

---

## What Cerberus is

A zero-knowledge password vault (encrypted credential store) with a risk-based adaptive
authentication layer driven by keystroke behavioral analysis + contextual signals. Bachelor
thesis (FDIBA). Stack: Tauri + Rust (desktop/security core), React + TypeScript (UI),
Node.js + Express (server), PostgreSQL, WebSocket (later, continuous auth).

## Working method

- I (planning chat) act as architect/reviewer; Claude Code does the implementation.
- One milestone per Claude Code prompt. Each prompt ends with a fixed REPORT block.
- The human pastes the report back here; I verify it against PROJECT.md + ADRs, then issue the
  next milestone prompt (or corrections). Milestone prompts are written as docs/claude-code-\*.md.

## Status — Phase 1 COMPLETE and CI-green on real infrastructure

- **M1 Scaffold + CI** ✅ — monorepo, hermetic Rust core job, TS job, tooling enforcing §4.
- **M2 Rust crypto core** ✅ — ADR-0001 key hierarchy. Argon2id (224 MiB / t=3 / p=1, ~521 ms,
  kdf_version=1), HKDF-SHA-256, XChaCha20-Poly1305. KAT vectors from RFC 9106 / RFC 5869 /
  draft-arciszewski. Tamper→fail and wrong-key→Err proven. 32+ tests.
- **M3 Tauri wiring + local vault CRUD** ✅ — Tauri behind a `desktop` Cargo feature (hermetic
  core preserved); local encrypted persistence; on-disk-no-plaintext + zeroize-on-lock proven.
- **M4 Zero-knowledge login + device enrollment** ✅ — prelogin→derive→verify handshake;
  enumeration mitigation (deterministic dummy params); constant-time verify (static dummy hash
  fixed a cold-start timing leak, found by an adversarial review); per-IP + per-account
  rate-limit; device fingerprint hashed; server stores only an Argon2id hash of the auth key.
- **M5 Encrypted blob sync** ✅ — completes Phase 1. Authenticated, user-scoped opaque-blob CRUD;
  revision optimistic concurrency (409); cross-user denial (404, repository-enforced, no IDOR);
  HEADLINE fresh-client E2E passes (create→push→fresh login→unwrap→pull→decrypt==original) with
  server-blindness asserted. `cerberus-cli` test oracle added (reusable for §6 eval scripts).
- **Build hotfix** ✅ — an upstream E0119 coherence conflict (tauri-utils 2.9.2 ↔ a too-new
  `time`) was fixed by pinning `time = "=0.3.47"` + committing Cargo.lock. ALL THREE CI JOBS now
  green on a real GitHub ubuntu runner (the first fully-green hosted pipeline; closed the
  long-standing "never pushed" item).

## ADRs in the repo (docs/adr/) — these feed the thesis directly

- 0001 crypto model (key hierarchy, Argon2id/HKDF/AEAD, pinned params)
- 0002 behavioral baselines & scoring (server-side, model-only, Mahalanobis primary +
  SVM/iforest offline comparison; CMU dataset for validation)
- 0003 hermetic Phase-0 CI / deferred Tauri (the `desktop` feature seam)
- 0004 repo tooling baseline
- 0005 crypto wire format & domain separation (24-byte nonce + ct‖tag; AAD labels;
  HKDF salt=none policy)
- 0006 desktop app architecture (feature-gating; the time pin — marked RESOLVED)
- 0007 zero-knowledge login handshake (prelogin/enumeration mitigation; documented low-sev limits)
- 0008 encrypted blob sync (revision concurrency, fresh-client bootstrap, repo-level user scoping)

## Thesis writeup

- Phase 1 chapter drafted as a Word doc (Cerberus_Phase1.docx): problem definition → theoretical
  solution (zero-knowledge) → practical solution → verification. Maps to the assignment structure.
  TODO when integrating: add citations (RFC 9106, RFC 5869, Argon2 paper, OWASP) where primitives
  are first named; demote heading levels if it's a sub-chapter; optional key-hierarchy diagram.

## NEXT: M6 — keystroke capture + enrollment (prompt is READY: docs/claude-code-milestone-6.md)

Locked M6 design decisions (do not reopen):

- Keystroke ONLY (mouse deferred to Phase 7 / continuous auth).
- Live signal = master-password keystroke timing; CMU dataset used OFFLINE for detector validation.
- Features = standard CMU vector (hold + down-down + up-down latencies), **position-indexed,
  NEVER character identity** (the privacy rule; extends Phase 1 zero-knowledge into behavior).
- Baseline server-side, model-only (mean + covariance), encrypted at rest, pseudonymized
  (ADR-0002). ~10 samples to activate (configurable). Raw samples purged on activation.
- M6 = capture + enrollment + baseline fit ONLY. Scoring is M7.

Two things to watch when reviewing the M6 report:

1. The position-indexed privacy rule genuinely holds (no character identity anywhere; password
   path to Rust unchanged and separate; assertions prove it).
2. Covariance regularization (shrinkage / diagonal loading) so the matrix is invertible —
   M7's Mahalanobis needs the inverse. Expect ADR-0009.

## Roadmap after M6

- M7 Mahalanobis scoring + offline detector comparison (Phase 4) → first FAR/FRR/EER numbers
- M8 Contextual signals (Phase 5) — new-device, geovelocity, time-of-day, failure-velocity
- M9 Adaptive policy + step-up auth (Phase 6) → ADR for tuned thresholds; revisit the naive
  per-account lockout (the M4 DoS tradeoff) once failure-velocity scoring exists
- M10 Continuous auth over WebSocket (Phase 7) — mouse dynamics land here
- M11 Evaluation harness + reproducible results (Phase 8)

## Standing notes / loose ends (non-blocking)

- GUI sync wiring (push-on-change / pull-on-unlock in the live app) is the remaining Phase-1
  app-integration polish; the crypto+API+server chain is proven by the E2E.
- `cerberus-cli` opsec: keep it out of the shipped binary (dev/test only); read the master
  password from stdin/env, never argv. (Flagged; confirm done.)
- npm audit advisories are dev-only build tooling (vite/vitest), deferred; document the rationale.
- Conflict handling is blob-level (revision 409), not field-level merge — future work (ADR-0008).

```

```
