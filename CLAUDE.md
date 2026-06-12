# CLAUDE.md — Project Cerberus

Standing context for Claude Code. Read this and the files it points to before changing anything.
This file holds DURABLE rules; it is not a changelog. Planning history lives elsewhere.

## What this is

A zero-knowledge password vault with risk-based adaptive authentication (keystroke behavioral
analysis + contextual signals). Security-critical bachelor-thesis project. Correctness and the
security invariants below take precedence over speed or convenience.

## Read these first (authoritative)

- `PROJECT.md` — architecture (§2), coding rules (§4), data/privacy (§5), testing gates (§6).
- `docs/adr/` — every binding decision, numbered. The ADR index:
  - 0001 crypto model · 0002 behavioral baselines & scoring · 0003 hermetic CI / desktop feature
  - 0004 tooling baseline · 0005 crypto wire format & domain separation · 0006 desktop architecture
  - 0007 zero-knowledge login handshake · 0008 encrypted blob sync
  - 0009 behavioral feature schema, position-indexed capture & enrollment lifecycle
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
   the behavioral path. Behavioral baselines are server-side, MODEL-ONLY (mean + covariance),
   encrypted at rest, pseudonymized; raw enrollment samples are purged on baseline activation
   (ADR-0002). Feature vectors are biometric-adjacent: never logged beside identity, never
   returned raw over the API.
5. **Fail closed.** On ambiguity in an auth/risk path, escalate or deny — never silently grant.

## Engineering rules

- Server layering: routes → services → repositories. Routes touch no DB. All SQL parameterized,
  only in repositories. Every query scoped to the authenticated user (no IDOR). zod-validate every
  external boundary, including replies from Rust across the IPC boundary.
- TypeScript: strict, no `any`, named exports, no floating promises.
- Tauri is behind the `desktop` Cargo feature; the crypto/vault core must always build and test
  WITHOUT it (hermetic, ADR-0003).
- No magic numbers in the risk/behavioral code: thresholds/weights/sample-counts are named config.
- `time` is pinned `=0.3.47` (ADR-0006); build CI with `--locked`. Don't bump it.
- `cerberus-cli` is a dev/test oracle: never ship it in the production binary; it must read the
  master password from stdin/env, never argv.

## Testing gates (must pass before merge)

- `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (hermetic core + `--features desktop`)
- `tsc --noEmit`, `eslint`, `vitest` (repositories tested against a REAL ephemeral Postgres, not mocks)
- Crypto: known-answer tests from published vectors; tamper→auth-failure and wrong-key→clean-Err.
- Security properties are demonstrated by tests, not asserted in prose.

## Process

- Conventional Commits; short-lived branches; commit a `Cargo.lock`.
- Any decision with lasting consequences gets an ADR in `docs/adr/` (these double as thesis material).
- If a rule here blocks a task, STOP and report it — do not weaken a rule to make a build or test pass.

```

```
