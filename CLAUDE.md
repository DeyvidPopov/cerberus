# CLAUDE.md — Project Cerberus

Standing context for Claude Code. Read this and the files it points to before changing anything.
This file holds DURABLE rules; it is not a changelog. Planning history lives elsewhere.

## What this is

A zero-knowledge password vault with risk-based adaptive authentication: keystroke + mouse
behavioral analysis and contextual signals, enforced at login (adaptive grant / TOTP step-up /
deny) and continuously in-session (mouse-dynamics spike → vault lock). Tauri + Rust desktop core,
React + TypeScript webview (shadcn/ui + Tailwind), Node/Express + PostgreSQL server, WebSocket for
continuous auth. Security-critical bachelor-thesis project. Correctness and the security invariants
below take precedence over speed or convenience.

## Read these first (authoritative)

- `PROJECT.md` — architecture (§2), coding rules (§4), data/privacy (§5), testing gates (§6).
- `docs/adr/` — every binding decision, numbered. The ADR index:
  - 0001 crypto model · 0002 behavioral baselines & scoring · 0003 hermetic CI / desktop feature
  - 0004 tooling baseline · 0005 crypto wire format & domain separation · 0006 desktop architecture
  - 0007 zero-knowledge login handshake · 0008 encrypted blob sync
  - 0009 behavioral feature schema, position-indexed capture & enrollment lifecycle
  - 0010 Mahalanobis→χ² scoring & offline detector comparison (Killourhy & Maxion)
  - 0011 contextual risk signals (new-device, geovelocity, time-of-day, failure-velocity)
  - 0012 adaptive policy + enforcement + TOTP step-up (combiner, bands, brute-force model)
  - 0013 continuous auth: mouse dynamics, windowed WS streaming, spike→lock (modality reuse)
  - 0014 evaluation methodology: Balabit mouse benchmark, operating-point tuning, integrated study
  - 0015 UI design system ("Vault" direction): shadcn/ui + Tailwind tokens, no-risk-detail copy rule
- `docs/threat-model.md` — assets, adversaries, trust boundaries.

## Non-negotiable security invariants

1. **Zero-knowledge.** The server stores only ciphertext, key hashes, and non-secret metadata.
   The master password, derived keys, and plaintext credentials NEVER reach the server — not in
   any endpoint, log, error, or test fixture.
2. **Crypto lives in Rust.** All vault key derivation/encryption/secret handling is in the Rust
   core (`apps/desktop/src-tauri`). The sole permitted server-side crypto is hashing the already-
   derived auth key for storage (defense in depth). Secrets are zeroized; Debug is redacted;
   secret comparisons are constant-time; no `unwrap`/`expect`/`panic` in non-test code.
3. **AEAD only**, fresh random nonce per op, never reuse. Use the ADR-0005 wire format and AAD
   domain-separation labels exactly; never invent a new on-wire/on-disk format.
4. **Behavioral capture is position-indexed, never character identity.** Keystroke timing is
   captured by keystroke POSITION (hold/flight durations); the password characters never enter
   the behavioral path. Mouse dynamics (continuous auth, ADR-0013) is the SECOND modality —
   windowed motion statistics (velocity/accel/curvature/clicks/pauses), never pointer content —
   under the SAME rules; the χ² scorer + enrollment lifecycle are modality-agnostic (reused, not
   duplicated). All behavioral baselines are server-side, MODEL-ONLY (mean + covariance),
   encrypted at rest, pseudonymized; raw samples are purged on activation (ADR-0002). Feature
   vectors are biometric-adjacent: never logged beside identity, never returned raw over the API.
5. **Fail closed.** On ambiguity in an auth/risk path, escalate or deny — never silently grant.
6. **No risk detail in user-facing copy.** Denial / step-up / lock messages are generic ("Access
   denied", "Additional verification needed", "Locked for your security") and NEVER reveal which
   signal fired, the device, or the location (ADR-0012, ADR-0015). Each login outcome (granted /
   step-up / 401 / 403 / 429 / network / 5xx server-fault) renders a DISTINCT, non-leaking message.

## Engineering rules

- Server layering: routes → services → repositories. Routes touch no DB. All SQL parameterized,
  only in repositories. Every query scoped to the authenticated user (no IDOR). zod-validate every
  external boundary, including replies from Rust across the IPC boundary.
- TypeScript: strict, no `any`, named exports, no floating promises.
- Tauri is behind the `desktop` Cargo feature; the crypto/vault core must always build and test
  WITHOUT it (hermetic, ADR-0003).
- No magic numbers in the risk/behavioral code: thresholds/weights/sample-counts are named config.
- Heavy crypto MUST run off the webview main thread: Tauri key-derivation commands (Argon2id ~0.5 s)
  are `async` + `tauri::async_runtime::spawn_blocking` so the UI never freezes. Never lower the
  Argon2id params (ADR-0001) to "fix" lag — the fix is concurrency + a visible pending state.
- DB migrations are forward-only and ordered; the running database MUST be migrated before the new
  code runs — a query against a not-yet-added column surfaces as a 500 (`npm run migrate`). CI/tests
  use a real ephemeral Postgres that always applies every migration, so this only bites stale dev DBs.
- Desktop UI is shadcn/ui + Tailwind with design tokens centralized in `apps/desktop/tailwind.config.js`
  (ADR-0015) — no scattered inline colors. The master-password inputs stay real `<input>`s that the
  M6 keystroke capture observes; never swap them for a component that intercepts/debounces keys.
- `time` is pinned `=0.3.47` (ADR-0006); build CI with `--locked`. Don't bump it.
- `cerberus-cli` is a dev/test oracle: never ship it in the production binary; it must read the
  master password from stdin/env, never argv.

## Testing gates (must pass before merge)

- `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (hermetic core + `--features desktop`)
- `tsc --noEmit`, `eslint`, `vitest` (repositories tested against a REAL ephemeral Postgres, not mocks)
- Crypto: known-answer tests from published vectors; tamper→auth-failure and wrong-key→clean-Err.
- Security properties are demonstrated by tests, not asserted in prose.

## Process

- Conventional Commits; short-lived branches; commit a `Cargo.lock`. The full per-milestone git
  loop (branch from main → commit → ff-only merge → push → confirm CI green) is in `GIT_WORKFLOW.md`.
- Any decision with lasting consequences gets an ADR in `docs/adr/` (these double as thesis material).
- If a rule here blocks a task, STOP and report it — do not weaken a rule to make a build or test pass.
