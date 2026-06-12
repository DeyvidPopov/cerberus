# ADR-0006 — Desktop App Architecture (Tauri wiring, command split, local vault)

- Status: **Accepted**
- Context: Milestone 3 wires the Tauri runtime and local vault CRUD onto the M2 crypto core.
- Related: PROJECT.md §1, §2, §4.1, §4.2; ADR-0001 (crypto), ADR-0003 (hermetic CI / deferred
  Tauri), ADR-0005 (wire format).

## Context

Milestone 3 must (a) wire the Tauri runtime and expose a command surface, while (b) keeping the
crypto/vault core hermetically testable without Tauri (ADR-0003), (c) keeping commands thin with
no business logic (§4.1), and (d) persisting credentials encrypted with the ADR-0005 format.

## Decision

1. **The Tauri runtime is gated behind a Cargo `desktop` feature.** `tauri` and `tauri-build`
   are optional dependencies; the `commands` module and the `generate_context!` entry point are
   `#[cfg(feature = "desktop")]`; the binary declares `required-features = ["desktop"]`. So
   `cargo test`/`cargo clippy` with default features compile and test ONLY the pure crypto/vault
   core (the hermetic CI job), and a separate CI job builds the app with `--features desktop`
   after installing the webview system libraries and building the frontend dist (which
   `generate_context!` embeds).

2. **Command logic lives in a pure `vault::VaultManager`**, not in the command wrappers. The
   manager owns unlock/lock and credential CRUD plus persistence and is unit-tested with
   `cargo test` (no Tauri). The `#[tauri::command]` functions are thin adapters: lock the shared
   manager, call one method, map the error to a non-leaking string. This satisfies "commands are
   a thin boundary" (§4.1) and means the command-layer behaviour is covered by the hermetic tests.

3. **Local persistence is a single JSON vault file** in the OS app-data directory, in the
   ADR-0005 wire format (base64 `nonce` + `ct‖tag`, the `cerberus/vault-key-wrap/v1` and
   `cerberus/credential/v1` AAD labels). It stores ONLY ciphertext plus the public KDF
   params/salt needed to re-derive keys. Writes are atomic (temp file + rename). First unlock
   initializes a new vault with the given master password; later unlocks verify the password by
   unwrapping the stored vault key (a wrong password fails as a clean decryption error).

4. **Secret handling at the boundary.** The master password arrives as a `String`, is moved into
   a zeroizing `SecretString` immediately, and is wiped when the command returns. Derived keys
   never leave Rust and never appear in any command return value, log, or error. The structs that
   carry credential plaintext have no `Debug` impl, so a credential cannot be accidentally logged.

5. **Toolchain.** CI builds the desktop app with `dtolnay/rust-toolchain@stable`. A pinned
   `rust-toolchain.toml` was intentionally NOT added: see the "Known issue" below — no toolchain
   available in the current dev environment compiles the Tauri 2.11 dependency tree, so pinning a
   version here would pin a broken one. The hermetic core builds on any recent stable.

## Known issue — Tauri dependency tree does not compile locally

In the development environment, `cargo build --features desktop` fails to compile the
third-party `tauri-utils 2.9.2` and `cookie 0.18.1` crates with `error[E0119]` (conflicting
`From<…HourBase>` impl) coming from `time 0.3.48`. This is independent of Cerberus code (the
app's own modules never reach compilation). The constraints that make it unresolvable by version
pinning here:

- `time 0.3.48`, `serde_with 3.21`, and `plist 1.9` all require **rustc ≥ 1.88**.
- Every available toolchain ≥ 1.88 (1.88, 1.89, 1.90, 1.96) hits the `time`/`tauri-utils`
  coherence error; toolchains < 1.88 fail the deps' MSRV (and < 1.85 lack edition2024).
- `time` cannot be downgraded below the offending 0.3.42 because `plist 1.9` (required by
  `tauri-utils`) needs `time ≥ 0.3.47`.

The crypto/vault core, persistence, command logic, IPC validators, UI, and the frontend dist all
build and pass their tests. The remaining step — linking the Tauri runtime binary — must be
verified on CI infrastructure whose `stable` Rust compiles this dependency tree.

## Consequences

- The security core stays hermetic, fast, and fully tested independent of the UI/runtime.
- The desktop build is an isolated, reviewable CI step with its own system dependencies.
- The vault is offline-first; "create on one client, decrypt on a fresh client" (Phase 1) is
  supported by the stable ADR-0005 on-disk format.

## Alternatives considered

- **Two separate crates (core + app)** — rejected; the `desktop` feature keeps the exact §2
  single-crate `src-tauri` layout while achieving the same hermetic separation.
- **Inlining crypto/CRUD in the `#[tauri::command]` functions** — rejected; violates §4.1 and
  would make the command logic untestable without the Tauri runtime.
