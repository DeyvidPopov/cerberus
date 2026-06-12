# Project Cerberus — Development Plan & Codebase Rules

> _Cerberus — the three-headed guardian of the threshold. Nothing passes unrecognized._

An adaptive authentication vault: a zero-knowledge password manager (encrypted credential
vault) with a risk-based adaptive authentication layer driven by behavioral analysis and
contextual signals.

The name maps to the architecture — **three heads guard the gate**:

1. **Crypto** — the zero-knowledge vault; secrets pass only with the right key.
2. **Behavior** — keystroke and mouse dynamics; recognizing _how_ you act, not just what you know.
3. **Context** — device, location, and risk signals; recognizing the circumstances of the attempt.

A request must satisfy all three heads to pass cleanly; failing one wakes the guardian (step-up auth).

Stack: **Tauri + Rust** (desktop core), **React + Next.js** (UI/dashboard),
**Node.js + Express** (API), **PostgreSQL** (storage), **WebSocket** (real-time
telemetry & continuous auth).

This document is the single source of truth for _how_ the project is built. Read it
before writing code. Architectural decisions that deviate from it must be recorded as
an ADR (see §7).

---

## 1. Core design principles (non-negotiable)

These define the whole project. If a feature conflicts with one of these, the feature is wrong.

1. **Zero-knowledge.** The server stores only ciphertext and an authentication proof.
   It never sees the master password, the encryption key, or any plaintext credential —
   not in memory, not in logs, not in test fixtures, not in DB dumps.
2. **Crypto lives in Rust.** All key derivation, encryption, decryption, and secret
   handling happen in `src-tauri`. The webview (JS/TS) never holds derived keys and only
   touches the master password long enough to hand it to Rust.
3. **Two halves, cleanly separated.** The _vault_ (password manager) and the _adaptive
   auth engine_ (risk scoring) are independent modules with a defined interface. Neither
   reaches into the other's internals.
4. **Explainable over clever.** Every risk decision must be reconstructible: which signals
   fired, what score they produced, which policy band was hit. No black-box scoring that
   can't be written up and defended.
5. **Fail closed.** On any ambiguity in the auth/risk path (missing baseline, telemetry
   error, scoring failure) the system escalates to step-up or denies — never silently grants.

---

## 2. Repository structure

Monorepo. One place to reason about contracts shared between client and server.

```
/
├── apps/
│   ├── desktop/                # Tauri application
│   │   ├── src/                # React + TS frontend (webview)
│   │   │   ├── features/       # vault, auth, behavioral-capture, dashboard
│   │   │   ├── lib/            # api client, tauri bridge, ws client
│   │   │   └── components/     # shared UI
│   │   └── src-tauri/          # Rust core (security-critical)
│   │       └── src/
│   │           ├── crypto/     # KDF, AEAD, key hierarchy, zeroizing types
│   │           ├── vault/      # encrypt/decrypt credentials, unlock state
│   │           ├── commands/   # #[tauri::command] FFI surface
│   │           └── error.rs
│   └── server/                 # Express API
│       └── src/
│           ├── routes/         # HTTP surface, thin
│           ├── services/       # business logic (auth, vault-sync, risk)
│           ├── risk/           # behavioral + contextual scoring engine
│           ├── repositories/   # all DB access
│           ├── ws/             # WebSocket handlers
│           └── middleware/
├── packages/
│   ├── shared-types/           # TS types = the API contract (single source)
│   └── protocol/              # documented crypto constants + wire formats
├── migrations/                 # ordered SQL migrations (forward-only)
├── docs/
│   ├── adr/                    # architecture decision records
│   ├── threat-model.md
│   └── evaluation/             # FAR/FRR results, datasets, reproducible scripts
└── PROJECT.md                  # this file
```

**Rule:** the API contract is defined once in `packages/shared-types` and imported by both
client and server. No hand-duplicated request/response shapes.

---

## 3. The cryptographic model (implement exactly)

```
master password
      │  Argon2id (documented params in packages/protocol)
      ▼
   master key  ──split──►  auth key      → sent to server as login proof (server stores a hash)
                       └►  encryption key → never leaves client
                                 │
                                 ▼  unwraps
                          vault symmetric key (random, per-user, AEAD-encrypted at rest)
                                 │
                                 ▼
                          per-credential ciphertext (AEAD)
```

Rules:

- KDF is **Argon2id** with parameters pinned in `packages/protocol` and recorded in an ADR.
  Parameters are versioned (`kdf_version`) so they can be raised later without breaking old vaults.
- Symmetric encryption is **AEAD only** (AES-256-GCM or XChaCha20-Poly1305). No unauthenticated modes, ever.
- Every secret type in Rust implements `Zeroize`/`ZeroizeOnDrop` and has a `Debug` impl that prints `[redacted]`.
- All secret comparisons are constant-time.
- A fresh random nonce/IV per encryption operation. Nonce reuse is a hard bug, not a style nit.
- The vault key is re-wrappable: changing the master password re-wraps the vault key, it does **not** re-encrypt every credential.

---

## 4. Coding conventions

### 4.1 Rust (`src-tauri`)

- Edition 2021. `cargo clippy -- -D warnings`, `cargo fmt` enforced in CI.
- **No `unwrap()` / `expect()` / `panic!` in non-test code.** Panics must never cross the
  Tauri command (FFI) boundary. Every fallible path returns `Result<T, AppError>`.
- One error enum via `thiserror`. Error messages exposed to the UI must not leak secret
  material or internal crypto detail.
- Secrets are typed (`SecretString`, `MasterKey`, …) — never bare `String`/`Vec<u8>` passed around.
- No `unsafe` without a `// SAFETY:` comment and an ADR.
- `#[tauri::command]` functions are a thin boundary: validate input, call into `crypto`/`vault`,
  return serializable DTOs. No business logic inline in commands.

### 4.2 TypeScript (frontend + server)

- `strict: true`. `any` is banned; use `unknown` + narrowing. `noUncheckedIndexedAccess` on.
- Validate every external boundary (HTTP body, WS message, IPC result) at runtime with **zod**.
  Trust nothing that crosses a process boundary, including replies from Rust.
- No secret material in React state, `localStorage`, `sessionStorage`, or component props.
  Persisted client data uses Tauri's secure storage; transient keys stay in Rust.
- Named exports, no default exports. Absolute imports from package roots.
- Async errors are handled explicitly — no floating promises (`no-floating-promises` lint on).

### 4.3 Server architecture (Express)

- Strict layering, dependencies point one direction only:
  `routes → services → repositories → db`. A route never touches the DB; a repository never
  contains business logic.
- **All SQL is parameterized.** String-concatenated queries are a blocking review failure.
- Repositories are the only place that knows SQL exists.
- Middleware order is fixed and documented: request-id → auth → rate-limit → validation → handler.
- Rate limiting on every auth and vault endpoint. Login is rate-limited per-account _and_ per-IP.

### 4.4 The risk engine (`server/src/risk`)

This module is the thesis contribution, so it has extra rules:

- **No magic numbers.** Every threshold, weight, and policy band is named config in one file,
  not scattered literals. They must be tunable without code changes (for FAR/FRR sweeps).
- Each signal is an isolated, independently testable unit: `keystrokeAnomaly`, `mouseAnomaly`,
  `newDevice`, `impossibleTravel`, `timeOfDayDeviation`, `failureVelocity`.
- Signals output a normalized sub-score + a structured _reason_. The combiner produces the
  composite score and the chosen policy band (grant / step-up / deny).
- Every decision is logged as a structured record: input signals, sub-scores, composite,
  band, action. This log _is_ the evaluation dataset — treat it as a first-class output.
- Scoring is deterministic given the same inputs and seeded model state (required for
  reproducible evaluation).

---

## 5. Data & privacy rules

- Behavioral feature vectors are **sensitive biometric-adjacent data**. They are never
  logged in plaintext alongside identities, never returned over the API in raw form, and
  their storage location (encrypted / on-device / pseudonymized) is decided in an ADR before
  any capture code is written.
- PII and risk features are excluded from application logs. Logs carry IDs and decisions, not raw data.
- Test fixtures and seed data contain **only** synthetic credentials and synthetic behavioral
  samples. Never real passwords, never real keystroke captures from a person without consent
  recorded in `docs/`.
- DB migrations are forward-only and ordered; no editing a migration after it has run anywhere.

---

## 6. Testing & quality gates

- **Crypto:** known-answer tests against published test vectors, plus round-trip property
  tests (`encrypt(decrypt(x)) == x`, tamper → auth failure). Crypto changes require new vectors.
- **Risk engine:** deterministic unit tests per signal; an evaluation harness that runs the
  combiner over a labeled dataset and reports FAR / FRR / EER. Validate against a public
  benchmark (e.g. the CMU keystroke-dynamics dataset) so numbers are comparable.
- **Server:** integration tests hit a real ephemeral Postgres (not mocks) for repositories.
- CI must pass before merge: `clippy -D warnings`, `cargo test`, `tsc --noEmit`, eslint,
  TS tests. A red pipeline blocks the merge.
- Reproducibility: every number that appears in the thesis evaluation chapter is produced
  by a committed script in `docs/evaluation/` that anyone can re-run.

---

## 7. Process & git

- **Conventional commits**: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `sec:`.
- Branch naming: `feat/vault-unlock`, `fix/nonce-reuse`, `risk/impossible-travel`.
- Trunk-based: short-lived branches, small PRs, each PR green and self-contained.
- **ADRs** (`docs/adr/NNNN-title.md`) for every decision with lasting consequences: KDF
  parameters, where baselines are stored, which anomaly method, the policy-band table, the
  threat model. These double as raw material for the theoretical chapter of the thesis.
- Secrets and `.env` never committed; `.env.example` documents required variables.
