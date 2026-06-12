# ADR-0003 — Hermetic Phase-0 CI & Deferred Tauri Runtime

- Status: **Accepted**
- Context: emerged from Milestone 1 (scaffold + CI).
- Related: `PROJECT.md` §2, §8 (Phase 0 exit criterion); ADR-0001.

## Context

Wiring the full Tauri runtime (the `tauri` dependency, `tauri.conf.json`, and
`generate_context!`) couples `cargo clippy`/`cargo test` to a built frontend dist and to
webkit system libraries. On CI this is heavy and flaky and contradicts the Phase-0 exit
criterion: "CI green on an empty build."

## Decision

The `src-tauri` crate ships during Phase 0 as a **pure Rust security-core crate** with the
exact `crypto/ vault/ commands/ error.rs` module layout and a `thiserror` `AppError`, but
**without** the `tauri` runtime dependency or `tauri.conf.json`.

- `crypto` and `vault` are plain Rust modules, unit-testable with `cargo test`, needing no
  frontend build and no system webkit deps.
- The `#[tauri::command]` FFI wrappers in `commands/` are the **only** part gated on the
  runtime; they are wired when the webview first needs to invoke Rust (vault unlock UI).

**Trigger to wire Tauri:** Phase 1 / Milestone 3, when the desktop UI first calls into the
Rust core.

## Consequences

- Phase-0 and crypto-core CI stay hermetic and reliably green.
- The crypto/vault security core can be built and fully tested as ordinary Rust ahead of any
  UI — which is desirable for a security-critical core anyway.
- A later milestone owns "wire Tauri + expose the command surface" as a discrete, reviewable step.

## Alternatives considered

- **Wire Tauri now** — rejected: flaky CI, webkit system deps, contradicts the exit criterion.
- **Mock `generate_context!`** — rejected: added complexity for zero Phase-0 benefit.
