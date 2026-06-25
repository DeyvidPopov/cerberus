# Repository map — every directory and file

> Part of the Cerberus encyclopedia. See [Architecture](02-architecture.md) for how these
> pieces talk at runtime, and the [glossary](13-glossary.md) for any term you don't recognize.

---

## 1. In plain English

Cerberus is a **monorepo**: one Git repository that holds several related projects side by side
instead of scattering them across many repos. Picture a workshop with labeled drawers — there is a
drawer for the desktop app, a drawer for the server, a drawer for the shared "contract" between
them, a drawer for database migrations, and a drawer for documentation. This page is the **index
card taped to the front of the cabinet**: it tells you which drawer holds what, one line per file
that matters, so that when you ask "where do I find the encryption code?" or "where is the login
route?" you go straight to it.

Two build systems live in this one tree. The JavaScript/TypeScript side is organized with **npm
workspaces** (`apps/*`, `packages/*`, `migrations` — declared in [package.json](../../package.json)
lines 10–14). The Rust side is a **Cargo workspace** with a single crate, the desktop security core
(declared in [Cargo.toml](../../Cargo.toml) line 6). "Workspace" in both tools means: many
sub-projects that share one lockfile and one set of root rules.

One important caveat, repeated throughout this page: **we are on the branch
`feat/inspector-live-data`, and several fully-working files are not yet committed to Git**. The
file-by-file list below covers the *working tree* (what is actually on disk), enumerated with
`git ls-files --cached --others --exclude-standard`, not just what `git ls-files` alone would show.
Untracked files are marked **[untracked]**; superseded/deleted files are noted where relevant.

---

## 2. Where it lives

The whole repository. Top-level layout:

```
cerberus/
├── apps/
│   ├── desktop/          Tauri app: Rust security core (src-tauri) + React webview (src)
│   └── server/           Node/Express API + the risk engine + WebSocket
├── packages/
│   ├── shared-types/     the API/IPC contract (zod schemas + inferred TypeScript types)
│   └── protocol/         crypto constants only, no logic (mirrored by hand in Rust)
├── migrations/           6 forward-only SQL migrations + a TypeScript runner
├── docs/                 ADRs, threat model, evaluation results, appendices, design mockups
├── .github/workflows/    CI pipeline
└── root configs          package.json, Cargo.toml, tsconfig.base.json, eslint, vitest, etc.
```

---

## 3. File-by-file

> **Test-file convention (read once, applies everywhere).** Tests sit *next to* the code they
> test, named `<name>.test.ts` / `<name>.test.tsx` (Vitest) for TypeScript and as `#[cfg(test)]`
> modules *inside* each `.rs` file for Rust. Crypto/round-trip vectors, repository tests against a
> real Postgres, and route integration tests follow this same co-location rule. To avoid noise this
> page does **not** list each `.test.ts` separately — assume `foo.ts` has a sibling `foo.test.ts`
> unless stated. End-to-end and shared test scaffolding are called out explicitly because they are
> not 1:1 with a source file.

### 3.1 Repository root — config & docs

| File | Job |
|---|---|
| [package.json](../../package.json) | Root npm workspace manifest; declares workspaces (`apps/*`, `packages/*`, `migrations`) and the top-level scripts (`typecheck`, `lint`, `test`, `migrate`, `dev:*`, `build:cli`, `demo:*`). Node `>=20.11`. |
| [package-lock.json](../../package-lock.json) | npm lockfile for the whole JS/TS tree. |
| [Cargo.toml](../../Cargo.toml) | Root Cargo workspace; one member (`apps/desktop/src-tauri`), shared lint policy (`unsafe_code = deny`, `unwrap_used`/`expect_used`/`panic = deny`), and a dev profile that optimizes *dependencies* (so Argon2id runs near release speed in `tauri dev`) — explicitly **not** lowering Argon2id params. |
| [Cargo.lock](../../Cargo.lock) | Committed Rust lockfile (CI builds `--locked`; `time` is pinned `=0.3.47`). |
| [tsconfig.base.json](../../tsconfig.base.json) | Strict shared TypeScript config (`noUncheckedIndexedAccess`, etc.) every package extends. |
| [eslint.config.mjs](../../eslint.config.mjs) | Flat ESLint config; bans `any`, default exports, floating promises. |
| [vitest.config.ts](../../vitest.config.ts) | Root Vitest test-runner config. |
| [rustfmt.toml](../../rustfmt.toml) | Rust formatting rules (`cargo fmt --check` in CI). |
| [.env.example](../../.env.example) | Documents required environment variables; real `.env` is never committed. |
| [.gitignore](../../.gitignore) | Ignore rules (notably the gitignored CMU/Balabit datasets). |
| [CLAUDE.md](../../CLAUDE.md) | Durable engineering rules / standing context. |
| [PROJECT.md](../../PROJECT.md) | The development plan: architecture (§2), coding rules (§4), data/privacy (§5), testing gates (§6). |
| [README.md](../../README.md) | Project intro — **stale**: claims "Milestone 1 … no crypto/vault/risk yet" while the code implements the full system. See [overview](01-overview.md). |
| [ROADMAP.md](../../ROADMAP.md) | Milestone roadmap. |
| [DEV_RUNBOOK.md](../../DEV_RUNBOOK.md) | How to run things locally. See [build/run/test](12-build-run-test.md). |
| [GIT_WORKFLOW.md](../../GIT_WORKFLOW.md) | The per-milestone branch→merge→CI git loop. |
| [cerberus-window.png](../../cerberus-window.png) **[untracked]** | Screenshot of the app. |

### 3.2 `.github/workflows/`

| File | Job |
|---|---|
| [ci.yml](../../.github/workflows/ci.yml) | Three CI jobs: (1) hermetic Rust core (`fmt`, `clippy -D warnings`, `cargo test --workspace`, no Tauri); (2) desktop Tauri build (`--features desktop`); (3) TypeScript (`typecheck`, `lint`, `vitest`) against a real ephemeral Postgres, building `cerberus-cli` for the E2E test. |

### 3.3 `apps/desktop/src-tauri/` — the Rust security core

> **This is the only place secrets live.** All key derivation, encryption, decryption, and
> plaintext handling happen here. The crypto/vault core must build and test *without* the `desktop`
> Cargo feature (hermetic CI, ADR-0003). Details in [cryptographic core](04-cryptographic-core.md)
> and [vault & sync](05-vault-and-sync.md).

| File | Job |
|---|---|
| [Cargo.toml](../../apps/desktop/src-tauri/Cargo.toml) | Crate manifest; `tauri`, `tauri-build`, and `time =0.3.47` are pulled **only** by the `desktop` feature. |
| [build.rs](../../apps/desktop/src-tauri/build.rs) | Tauri build script. |
| [tauri.conf.json](../../apps/desktop/src-tauri/tauri.conf.json) | Tauri app config; CSP `connect-src` whitelists `http://localhost:8080` and `http://127.0.0.1:8080` for dev. |
| [icons/icon.ico](../../apps/desktop/src-tauri/icons/icon.ico), [icon.png](../../apps/desktop/src-tauri/icons/icon.png) | App icons. |
| [src/main.rs](../../apps/desktop/src-tauri/src/main.rs) | Binary entry → calls `lib.rs run()`. |
| [src/lib.rs](../../apps/desktop/src-tauri/src/lib.rs) | `run()`: builds the Tauri app, opens `app_data_dir/vault.json`, registers commands; setup error → `exit(1)` (fail closed). |
| [src/error.rs](../../apps/desktop/src-tauri/src/error.rs) | The single `thiserror` error enum; messages never leak crypto detail. |
| [src/crypto/mod.rs](../../apps/desktop/src-tauri/src/crypto/mod.rs) | Crypto module root; vault-key-wrap AAD label `cerberus/vault-key-wrap/v1`. |
| [src/crypto/kdf.rs](../../apps/desktop/src-tauri/src/crypto/kdf.rs) | **Argon2id** master-key derivation (224 MiB / t=3 / p=1, 32-byte output, `KDF_VERSION=1`) + **HKDF-SHA-256** split into auth key / encryption key. (Timing benchmark is `#[ignore]`d.) |
| [src/crypto/aead.rs](../../apps/desktop/src-tauri/src/crypto/aead.rs) | **XChaCha20-Poly1305** AEAD: 24-byte fresh random nonce per op, 16-byte tag. |
| [src/crypto/secret.rs](../../apps/desktop/src-tauri/src/crypto/secret.rs) | Zeroizing secret newtypes (`SecretString`, `MasterKey`, …); `Debug` prints `[redacted]`; constant-time compares. |
| [src/vault/mod.rs](../../apps/desktop/src-tauri/src/vault/mod.rs) | Credential seal/open (AAD `cerberus/credential/v1`); also holds `rotate_master_password` (implemented, **not wired to any command** — see §6). |
| [src/vault/manager.rs](../../apps/desktop/src-tauri/src/vault/manager.rs) | `VaultManager`: the unlock/lock session state holding the in-memory keys. |
| [src/vault/store.rs](../../apps/desktop/src-tauri/src/vault/store.rs) | On-disk `vault.json` persistence — **snake_case** serialization. |
| [src/vault/account.rs](../../apps/desktop/src-tauri/src/vault/account.rs) | Account-creation / login handshake helpers. |
| [src/commands/mod.rs](../../apps/desktop/src-tauri/src/commands/mod.rs) | The `#[tauri::command]` IPC surface — **12 commands** (`prepare_registration`, `derive_login_auth_key_cmd`, `seal_credential`, `open_credential`, `sync_pull_merge`, `unlock`, `lock`, `add_credential`, `list_credentials`, `get_credential`, `update_credential`, `delete_credential`) + the `run()` registration. (`unlock` is synchronous; the five heavy-crypto commands `prepare_registration` / `derive_login_auth_key_cmd` / `seal_credential` / `open_credential` / `sync_pull_merge` are `async` + `spawn_blocking`.) |
| [src/bin/cerberus-cli.rs](../../apps/desktop/src-tauri/src/bin/cerberus-cli.rs) | **Dev/test crypto oracle**: subcommand from argv, JSON request on **stdin** (never argv), JSON response on stdout; builds without the desktop feature; used by the E2E test and demo scripts. Never shipped in production. |

### 3.4 `apps/desktop/src/` — the React + TypeScript webview

> The UI never holds derived keys; it touches the master password only long enough to hand it to
> Rust. Full tour in [frontend](11-frontend.md).

**Top-level shell**

| File | Job |
|---|---|
| [main.tsx](../../apps/desktop/src/main.tsx) | React entry; `createRoot(...).render(<App/>)`. |
| [App.tsx](../../apps/desktop/src/App.tsx) | Two-state shell: no session → `AuthScreen`, else `VaultView`. No router. |
| [vite-env.d.ts](../../apps/desktop/src/vite-env.d.ts) | Vite ambient types. |
| [styles/globals.css](../../apps/desktop/src/styles/globals.css) | Tailwind base + global styles. |

**`features/auth/`** — login & registration screens

| File | Job |
|---|---|
| [AuthScreen.tsx](../../apps/desktop/src/features/auth/AuthScreen.tsx) | The login/registration screen; drives the zero-knowledge handshake + keystroke capture. |
| [AuthFrame.tsx](../../apps/desktop/src/features/auth/AuthFrame.tsx) | Visual frame/layout wrapper for auth screens. |
| [TotpOnboarding.tsx](../../apps/desktop/src/features/auth/TotpOnboarding.tsx) **[untracked]** | TOTP setup flow (replaces the deleted `vault/TotpEnrollment.tsx`). |

**`features/vault/`** — the unlocked vault

| File | Job |
|---|---|
| [VaultView.tsx](../../apps/desktop/src/features/vault/VaultView.tsx) | The main vault UI: lists/edits credentials (local Rust vault), opens the continuous-auth WS. (Note: only **pulls** on unlock; does not push edits to the server on this branch — see §6.) |
| [OtpField.tsx](../../apps/desktop/src/features/vault/OtpField.tsx) **[untracked]** | Per-item local TOTP code field. |

> Deleted on this branch (superseded, no dangling imports): `features/vault/RiskInspector.{tsx,test.tsx}`
> and `features/vault/TotpEnrollment.{tsx,test.tsx}`.

**`features/inspector/`** **[entire dir untracked]** — the live risk-inspector dashboard (replaces the deleted `RiskInspector.tsx`)

| File | Job |
|---|---|
| [RiskDashboard.tsx](../../apps/desktop/src/features/inspector/RiskDashboard.tsx) | The inspector dashboard component. |
| [charts.tsx](../../apps/desktop/src/features/inspector/charts.tsx) | Chart primitives for the dashboard. |
| [icons.tsx](../../apps/desktop/src/features/inspector/icons.tsx) | Inspector-specific icons. |
| [live.ts](../../apps/desktop/src/features/inspector/live.ts) | Live-data wiring (consumes the `GET /risk/events` + WS score stream). |
| [model.ts](../../apps/desktop/src/features/inspector/model.ts) | View-model / data shapes for the dashboard. |
| [illustrative.ts](../../apps/desktop/src/features/inspector/illustrative.ts) | Illustrative/sample fallback data. |
| [theme.ts](../../apps/desktop/src/features/inspector/theme.ts) | Dashboard theme tokens. |

| File | Job |
|---|---|
| [features/index.ts](../../apps/desktop/src/features/index.ts) | Barrel re-export for feature modules. |

**`lib/`** — the bridges (IPC, HTTP, WS) and capture/util code

| File | Job |
|---|---|
| [tauri.ts](../../apps/desktop/src/lib/tauri.ts) | The Tauri IPC client; wraps `invoke` for all 12 commands, **zod-validates every reply**. |
| [api.ts](../../apps/desktop/src/lib/api.ts) | HTTP client for the server REST API. |
| [ws.ts](../../apps/desktop/src/lib/ws.ts) | Continuous-auth WebSocket client; streams mouse windows, handles `score`/`locked`. |
| [auth.ts](../../apps/desktop/src/lib/auth.ts) | Login/registration orchestration (prelogin → derive → login → unlock). |
| [auth-errors.ts](../../apps/desktop/src/lib/auth-errors.ts) | Maps each login outcome to a **distinct, non-leaking** user message. |
| [sync.ts](../../apps/desktop/src/lib/sync.ts) | Blob sync helpers (`pushNewItem`/`pushUpdatedItem`/pull-merge). |
| [keystroke.ts](../../apps/desktop/src/lib/keystroke.ts) | Keystroke feature-vector assembly (position-indexed timings). |
| [keystroke-capture.ts](../../apps/desktop/src/lib/keystroke-capture.ts) | Low-level keystroke event capture from `<input>` events. |
| [mouse-capture.ts](../../apps/desktop/src/lib/mouse-capture.ts) | Mouse-window feature capture (velocity/accel/curvature/clicks/pauses). |
| [otp.ts](../../apps/desktop/src/lib/otp.ts) **[untracked]** | Local per-item TOTP code generation. |
| [device.ts](../../apps/desktop/src/lib/device.ts) | Device fingerprint hashing. |
| [cn.ts](../../apps/desktop/src/lib/cn.ts) | `clsx` + `tailwind-merge` className helper. |

**`components/`** — shadcn-style UI primitives

| File | Job |
|---|---|
| [index.ts](../../apps/desktop/src/components/index.ts) | Barrel export. |
| [icons.tsx](../../apps/desktop/src/components/icons.tsx) | Shared icon set. |
| [ui/banner.tsx](../../apps/desktop/src/components/ui/banner.tsx), [button.tsx](../../apps/desktop/src/components/ui/button.tsx), [card.tsx](../../apps/desktop/src/components/ui/card.tsx), [input.tsx](../../apps/desktop/src/components/ui/input.tsx), [label.tsx](../../apps/desktop/src/components/ui/label.tsx), [wave.tsx](../../apps/desktop/src/components/ui/wave.tsx) | Tailwind/CVA UI primitives. The master-password `input` stays a real `<input>` so keystroke capture works. |

**Desktop build/config**

| File | Job |
|---|---|
| [package.json](../../apps/desktop/package.json) | `@cerberus/desktop` workspace; Vite + Tauri scripts. |
| [index.html](../../apps/desktop/index.html) | Vite HTML entry. |
| [vite.config.ts](../../apps/desktop/vite.config.ts) | Vite config. |
| [postcss.config.js](../../apps/desktop/postcss.config.js) | PostCSS (Tailwind) config. |
| [tailwind.config.js](../../apps/desktop/tailwind.config.js) | **Design tokens** live here (ADR-0015) — no scattered inline colors. |
| [tsconfig.json](../../apps/desktop/tsconfig.json) | Extends the base TS config. |

### 3.5 `apps/server/` — the Express API + risk engine

> Layering is strict: `routes → services → repositories → db`. Routes never touch SQL; repositories
> hold no business logic. Full tour in [server & API](09-server-and-api.md). The risk engine is the
> thesis contribution — see [behavioral engine](06-behavioral-engine.md),
> [decision & policy](07-decision-and-policy.md), and [algorithms deep-dive](14-algorithms-deep-dive.md).

**Top of `src/`**

| File | Job |
|---|---|
| [index.ts](../../apps/server/src/index.ts) | Process entry; `main()` loads config, opens GeoIP, creates the pg pool, attaches the WS, listens (default 8080). |
| [app.ts](../../apps/server/src/app.ts) | `createApp()`: wires middleware order, mounts routers, sets `trust proxy` (default false, per `TRUST_PROXY`). |
| [config.ts](../../apps/server/src/config.ts) | Typed/validated config from env. |
| [sync.e2e.test.ts](../../apps/server/src/sync.e2e.test.ts) | End-to-end test driving `cerberus-cli` against the server (built in CI). |

**`middleware/`** (fixed order: request-id → cors → json → authenticate → rate-limit → validate → handler → not-found → error)

| File | Job |
|---|---|
| [request-id.ts](../../apps/server/src/middleware/request-id.ts) | Attaches a request id. |
| [cors.ts](../../apps/server/src/middleware/cors.ts) | CORS policy. |
| [authenticate.ts](../../apps/server/src/middleware/authenticate.ts) | Bearer-token session auth. |
| [rate-limit.ts](../../apps/server/src/middleware/rate-limit.ts) | Per-IP / per-account rate limiting. |
| [validate.ts](../../apps/server/src/middleware/validate.ts) | zod request-body/param validation. |
| [async-handler.ts](../../apps/server/src/middleware/async-handler.ts) | Wraps async handlers to forward errors. |
| [not-found.ts](../../apps/server/src/middleware/not-found.ts) | Uniform 404. |
| [error-handler.ts](../../apps/server/src/middleware/error-handler.ts) | Central error responder (non-leaking). |

**`routes/`** (thin HTTP surface)

| File | Job |
|---|---|
| [index.ts](../../apps/server/src/routes/index.ts) | Router assembly. |
| [auth.ts](../../apps/server/src/routes/auth.ts) | `/auth/register`, `/prelogin`, `/login`, `/step-up/*`, `/totp/*`, `/me`; renders distinct non-leaking login outcomes. |
| [vault.ts](../../apps/server/src/routes/vault.ts) | `/vault/key`, `/vault/items` CRUD; not-found == not-owned (no IDOR leak). |
| [enrollment.ts](../../apps/server/src/routes/enrollment.ts) | `/enrollment/status`, `/enrollment/samples`. |
| [risk.ts](../../apps/server/src/routes/risk.ts) | `GET /risk/events` — gated `authenticate → requireStepUpConfirmed (403) → rate-limit`; output re-validated (the inspector feed). |
| [health.ts](../../apps/server/src/routes/health.ts) | `GET /health` (no DB, no auth). |

> Route test files include `auth`, `vault`, `enrollment`, `scoring`, `enforcement`, `contextual`,
> `cors`, `demo-readiness`, plus **[untracked]** `deny-explanation.test.ts` and `geovelocity.test.ts`.

**`services/`** (business logic)

| File | Job |
|---|---|
| [auth.ts](../../apps/server/src/services/auth.ts) | The login orchestration: verify auth key, enrol device, run behavioral + contextual scoring, combine, band, write `risk_events`. |
| [auth-crypto.ts](../../apps/server/src/services/auth-crypto.ts) | **Server-side** Argon2id hash of the *already-derived auth key* (19 MiB / t=2 / p=1) + the enumeration-safe dummy salt/hash. |
| [baseline-crypto.ts](../../apps/server/src/services/baseline-crypto.ts) | AES-256-GCM at-rest encryption of behavioral baselines (AAD bound to user id). |
| [secretbox.ts](../../apps/server/src/services/secretbox.ts) | AES-256-GCM at-rest box for TOTP secrets. |
| [contextual-risk.ts](../../apps/server/src/services/contextual-risk.ts) | Computes the contextual sub-scores (new-device, geovelocity, time-of-day, failure-velocity). |
| [risk-decision.ts](../../apps/server/src/services/risk-decision.ts) | Glue from sub-scores → combiner → policy band → action + backstops/bootstrap-grant. |
| [risk-explanation.ts](../../apps/server/src/services/risk-explanation.ts) **[untracked]** | The dev-gated deny breakdown attached to the 403 outside production. |
| [risk-inspector.ts](../../apps/server/src/services/risk-inspector.ts) | Builds the inspector event feed (never returns raw feature vectors). |
| [scoring.ts](../../apps/server/src/services/scoring.ts) | Behavioral sub-score: decrypt baseline, run the χ² scorer, fail-closed to "missing". |
| [enrollment.ts](../../apps/server/src/services/enrollment.ts) | Enrollment lifecycle: collect samples, activate baseline, purge raw samples. |
| [totp.ts](../../apps/server/src/services/totp.ts) | RFC 6238 TOTP core. |
| [totp-service.ts](../../apps/server/src/services/totp-service.ts) | TOTP setup/confirm/verify with replay watermark. |
| [geoip.ts](../../apps/server/src/services/geoip.ts) | Offline MaxMind GeoIP lookup. |
| [rate-limiter.ts](../../apps/server/src/services/rate-limiter.ts) | Rate-limit counters. |
| [vault.ts](../../apps/server/src/services/vault.ts) | Vault blob CRUD service. |
| [continuous-auth.ts](../../apps/server/src/services/continuous-auth.ts) | The EWMA spike detector (α = 0.5, threshold 0.85) → lock decision. |
| [health.ts](../../apps/server/src/services/health.ts) | Health-check logic. |

**`repositories/`** (all SQL; every query scoped to `user_id`)

| File | Job |
|---|---|
| [pool.ts](../../apps/server/src/repositories/pool.ts) | pg connection pool. |
| [users.ts](../../apps/server/src/repositories/users.ts), [vault-items.ts](../../apps/server/src/repositories/vault-items.ts), [vault-keys.ts](../../apps/server/src/repositories/vault-keys.ts), [devices.ts](../../apps/server/src/repositories/devices.ts), [sessions.ts](../../apps/server/src/repositories/sessions.ts), [behavioral-baselines.ts](../../apps/server/src/repositories/behavioral-baselines.ts), [enrollment-samples.ts](../../apps/server/src/repositories/enrollment-samples.ts), [login-failures.ts](../../apps/server/src/repositories/login-failures.ts), [risk-events.ts](../../apps/server/src/repositories/risk-events.ts), [step-up-challenges.ts](../../apps/server/src/repositories/step-up-challenges.ts), [totp-secrets.ts](../../apps/server/src/repositories/totp-secrets.ts) | One `createXRepository(db)` factory each, parameterized queries only. |
| [index.ts](../../apps/server/src/repositories/index.ts) | **Stale empty `export {}` stub** — real wiring is in `app.ts` (see §6). |
| [repositories.test.ts](../../apps/server/src/repositories/repositories.test.ts) | Repository tests against a real ephemeral Postgres. |

**`risk/`** — the thesis engine. See [algorithms deep-dive](14-algorithms-deep-dive.md).

| File | Job |
|---|---|
| [config.ts](../../apps/server/src/risk/config.ts) | **Every tunable**: risk bands (step-up 0.30, deny 0.70), combiner weights, ridge `1e-6`, enrollment thresholds (keystroke 10 / mouse 12), TOTP params, EWMA α/threshold, detector params. No magic numbers elsewhere. |
| [combiner.ts](../../apps/server/src/risk/combiner.ts) | Weighted-linear fusion of sub-scores → composite. |
| [policy.ts](../../apps/server/src/risk/policy.ts) | Maps composite → grant / step-up / deny band. |
| [scorer.ts](../../apps/server/src/risk/scorer.ts) | Mahalanobis D² → χ² CDF behavioral scorer (dof = feature dimension). |
| [mahalanobis.ts](../../apps/server/src/risk/mahalanobis.ts) | Mahalanobis distance math. |
| [chi-squared.ts](../../apps/server/src/risk/chi-squared.ts) | χ² CDF. |
| [baseline-model.ts](../../apps/server/src/risk/baseline-model.ts) | Mean + covariance model with Ledoit-Wolf shrinkage + diagonal ridge. |
| [continuous-auth.ts](../../apps/server/src/risk/continuous-auth.ts) | EWMA spike model for in-session mouse dynamics. |
| [eer.ts](../../apps/server/src/risk/eer.ts) | Equal-error-rate computation. |
| [evaluation.ts](../../apps/server/src/risk/evaluation.ts) | Evaluation harness over labeled datasets (FAR/FRR/EER). |
| [threshold-tuning.ts](../../apps/server/src/risk/threshold-tuning.ts) | Operating-point tuning. |
| [random.ts](../../apps/server/src/risk/random.ts) | Seeded RNG (mulberry32; the evaluation seed `20240601` is `EVALUATION_SEED` in `risk/config.ts`) for reproducibility. |
| [index.ts](../../apps/server/src/risk/index.ts) | Risk module barrel. |
| [cmu-loader.ts](../../apps/server/src/risk/cmu-loader.ts) + [cmu-loader.fixture.csv](../../apps/server/src/risk/cmu-loader.fixture.csv) | Loads the CMU keystroke benchmark (dataset gitignored; small fixture committed). |
| [balabit-loader.ts](../../apps/server/src/risk/balabit-loader.ts) | Loads the Balabit mouse benchmark (dataset gitignored). |
| `signals/` → [new-device.ts](../../apps/server/src/risk/signals/new-device.ts), [geovelocity.ts](../../apps/server/src/risk/signals/geovelocity.ts), [time-of-day.ts](../../apps/server/src/risk/signals/time-of-day.ts), [failure-velocity.ts](../../apps/server/src/risk/signals/failure-velocity.ts), [types.ts](../../apps/server/src/risk/signals/types.ts), [index.ts](../../apps/server/src/risk/signals/index.ts) | Each contextual signal as an isolated, testable unit. |
| `detectors/` → [isolation-forest.ts](../../apps/server/src/risk/detectors/isolation-forest.ts), [ocsvm.ts](../../apps/server/src/risk/detectors/ocsvm.ts), [scaler.ts](../../apps/server/src/risk/detectors/scaler.ts), [index.ts](../../apps/server/src/risk/detectors/index.ts) | Offline detector comparison (iForest, one-class SVM) for the thesis — not in the live path. |
| `geo/` → [haversine.ts](../../apps/server/src/risk/geo/haversine.ts), [centroids.ts](../../apps/server/src/risk/geo/centroids.ts) | Great-circle distance + coarse geo centroids for geovelocity. |

**`demo/`** **[dev-only, gated]** — see [build/run/test](12-build-run-test.md)

| File | Job |
|---|---|
| [cli.ts](../../apps/server/src/demo/cli.ts) | Demo CLI dispatcher. |
| [core.ts](../../apps/server/src/demo/core.ts) | Shared demo logic. |
| [env.ts](../../apps/server/src/demo/env.ts) | Demo env gating. |
| [seed.ts](../../apps/server/src/demo/seed.ts) | Seeds synthetic users/data. |
| [reset.ts](../../apps/server/src/demo/reset.ts) | Resets demo state. |
| [impostor.ts](../../apps/server/src/demo/impostor.ts) | Simulates an impostor login. |
| [samples.ts](../../apps/server/src/demo/samples.ts) | Synthetic behavioral samples. |
| [geovelocity.ts](../../apps/server/src/demo/geovelocity.ts) **[untracked]** | Geovelocity demo scenario. |

**`eval/`** **[dev-only]** — runnable evaluation scripts (`npm run eval:*`)

| File | Job |
|---|---|
| [run-keystroke-eval.ts](../../apps/server/src/eval/run-keystroke-eval.ts), [run-mouse-eval.ts](../../apps/server/src/eval/run-mouse-eval.ts), [run-threshold-tuning.ts](../../apps/server/src/eval/run-threshold-tuning.ts), [run-integrated-analysis.ts](../../apps/server/src/eval/run-integrated-analysis.ts) | Reproduce the committed evaluation numbers (seed `20240601`). |
| [integrated-study.ts](../../apps/server/src/eval/integrated-study.ts) | The integrated FAR/FRR study. |

**`ws/`**

| File | Job |
|---|---|
| [index.ts](../../apps/server/src/ws/index.ts) | The continuous-auth WebSocket server; serves only `/ws/continuous-auth`, auth at HTTP upgrade, spike → write `risk_events` + lock + close. |

**`test-support/`** — shared test scaffolding (not 1:1 with source)

| File | Job |
|---|---|
| [postgres.ts](../../apps/server/src/test-support/postgres.ts) | Spins the real ephemeral Postgres for tests. |
| [auth.ts](../../apps/server/src/test-support/auth.ts), [config.ts](../../apps/server/src/test-support/config.ts), [fixtures.ts](../../apps/server/src/test-support/fixtures.ts) | Test helpers and synthetic fixtures. |

| File | Job |
|---|---|
| [apps/server/package.json](../../apps/server/package.json), [tsconfig.json](../../apps/server/tsconfig.json) | `@cerberus/server` manifest + TS config. |

### 3.6 `packages/` — the shared contracts

> Skipping a per-file `.test.ts` recount per the convention above.

| File | Job |
|---|---|
| [shared-types/src/index.ts](../../packages/shared-types/src/index.ts) | The API/IPC contract: zod schemas + inferred TS types, imported by both client and server. |
| [shared-types/src/behavioral.ts](../../packages/shared-types/src/behavioral.ts) | Keystroke feature schema (`FEATURE_SCHEMA_VERSION=1`, dim `3n-2`, `MIN_KEYSTROKES=2`). |
| [shared-types/src/mouse.ts](../../packages/shared-types/src/mouse.ts) | Mouse feature schema (9 dims, window 32 / step 16, pause ≥120 ms) + the WS path/message types. |
| [shared-types/package.json](../../packages/shared-types/package.json), [tsconfig.json](../../packages/shared-types/tsconfig.json) | `@cerberus/shared-types` manifest + TS config (consumed as raw `.ts`). |
| [protocol/src/index.ts](../../packages/protocol/src/index.ts) | **Crypto constants only, no logic** (Argon2id params, KDF version) — hand-mirrored by Rust. |
| [protocol/package.json](../../packages/protocol/package.json), [tsconfig.json](../../packages/protocol/tsconfig.json) | `@cerberus/protocol` manifest + TS config (no deps). |

### 3.7 `migrations/` — forward-only schema

> Migrations apply in filename order, one transaction each, idempotent via `schema_migrations`.
> Details + the ER model in [database](10-database.md).

| File | Job |
|---|---|
| [0001_initial_schema.sql](../../migrations/0001_initial_schema.sql) | Users, vault items/keys, devices, sessions, baselines, enrollment samples, login failures, risk events. |
| [0002_enrollment_feature_schema_version.sql](../../migrations/0002_enrollment_feature_schema_version.sql) | Adds feature-schema-version column. |
| [0003_contextual_signals.sql](../../migrations/0003_contextual_signals.sql) | Contextual-signal columns. |
| [0004_step_up_auth.sql](../../migrations/0004_step_up_auth.sql) | TOTP secrets + step-up challenges. |
| [0005_mouse_modality.sql](../../migrations/0005_mouse_modality.sql) | Mouse-modality baseline support. |
| [0006_step_up_confirmed_session.sql](../../migrations/0006_step_up_confirmed_session.sql) | Step-up-confirmed flag on sessions (gates the inspector). |
| [migrate.ts](../../migrations/migrate.ts) | The runner (`npm run migrate`). |
| [package.json](../../migrations/package.json), [tsconfig.json](../../migrations/tsconfig.json) | `@cerberus/migrations` workspace. |

### 3.8 `docs/` — decisions, threat model, evaluation, design

| Path | Job |
|---|---|
| [docs/adr/0001…0015](../../docs/adr/) | The 15 numbered ADRs — every binding decision (crypto model, wire format, login handshake, blob sync, behavioral schema, scoring, contextual signals, policy/step-up, continuous auth, evaluation, UI). |
| [docs/threat-model.md](../../docs/threat-model.md) | Assets, adversaries, trust boundaries. |
| [docs/CERBERUS_HANDOFF.md](../../docs/CERBERUS_HANDOFF.md) | State-of-the-project handoff (declares M1–M12 complete). |
| [docs/DEMO.md](../../docs/DEMO.md) | Demo walkthrough. |
| [docs/geoip.md](../../docs/geoip.md) | GeoIP setup notes. |
| [docs/evaluation/](../../docs/evaluation/) | Committed reproducible results: keystroke/mouse detector comparisons (`.json` + `.md`), threshold tuning, README. |
| [docs/design/m12/](../../docs/design/m12/) | The three UI direction mockups + index (ADR-0015). |
| [docs/design/inspector/Risk Inspector.dc.html](../../docs/design/inspector/) **[untracked]** | Inspector design mockup. |
| [docs/schema-reference.md](../../docs/schema-reference.md) **[untracked]** | Human-readable DB schema reference (cross-linked by [database](10-database.md)). |
| [docs/appendices/appendix-B.md](../../docs/appendices/), [appendix-C.md](../../docs/appendices/), [appendix-D.md](../../docs/appendices/) **[untracked]** | Thesis appendices (cross-linked by [algorithms deep-dive](14-algorithms-deep-dive.md)). |
| [docs/encyclopedia/](../../docs/encyclopedia/) | This encyclopedia (incl. `00-RECON-NOTES.md` **[untracked]** — the verified source map). |

---

## 4. How it works (follow the structure)

The tree maps directly onto the request flow — read it top-down to "follow the data":

1. **A user types a master password** → captured by `apps/desktop/src/lib/keystroke-capture.ts`,
   handed to Rust via `apps/desktop/src/lib/tauri.ts`.
2. **Rust derives keys & encrypts** in `apps/desktop/src-tauri/src/crypto/*` and `vault/*`; the
   IPC boundary is `commands/mod.rs`. Plaintext and the encryption key never leave this drawer.
3. **The webview talks HTTP** through `apps/desktop/src/lib/api.ts` to `apps/server/src/routes/*`,
   which delegate to `services/*`, which delegate to `repositories/*`, which run SQL against the
   schema defined in `migrations/*`.
4. **The risk engine** (`apps/server/src/risk/*`) is called by `services/auth.ts` to turn signals
   into a grant/step-up/deny decision; **continuous auth** runs over `ws/index.ts`.
5. **The contract** binding client and server is `packages/shared-types`; the **crypto constants**
   that Rust and TS must agree on live in `packages/protocol`.

The two manifests at the root ([package.json](../../package.json), [Cargo.toml](../../Cargo.toml))
are what tie all of this into one buildable, testable monorepo.

---

## 5. How it connects

- **`packages/protocol`** is consumed by both `packages/shared-types`/the server *and* mirrored by
  the Rust crypto core — a single conceptual source of crypto constants (drift would break auth).
- **`packages/shared-types`** is the import seam between `apps/desktop/src/lib/*` and
  `apps/server/src/routes/*` — the same zod schemas validate both ends of every wire.
- **`migrations/`** defines the schema that `apps/server/src/repositories/*` query.
- **`apps/desktop/src-tauri/src/bin/cerberus-cli.rs`** is the bridge used by
  `apps/server/src/sync.e2e.test.ts` to exercise the real Rust crypto in CI.
- **`docs/adr/*`** is the *why* behind nearly every file here; this map is the *where*.

---

## 6. Gotchas & invariants

- **Document the working tree, not just `git ls-files`.** On `feat/inspector-live-data` the
  entire `features/inspector/` dir, `TotpOnboarding.tsx`, `OtpField.tsx`, `lib/otp.ts`,
  `services/risk-explanation.ts`, `demo/geovelocity.ts`, the appendices and `schema-reference.md`
  are **on disk and wired but not committed**. They are real and load-bearing. (RECON §2, §10.)
- **`repositories/index.ts` is a stale `export {}` stub** — do not look there for repository
  wiring; the real assembly is in `app.ts` (RECON §5d).
- **`rotate_master_password` exists in Rust but is wired to no command.** It is implemented in
  `vault/mod.rs` yet absent from the 12-command IPC surface in `commands/mod.rs` (RECON §11.1).
- **`VaultView` only pulls, never pushes.** `lib/sync.ts` has `pushNewItem`/`pushUpdatedItem`, but
  on this branch the vault UI mutates only the local Rust vault and pulls on unlock — confirm
  against ADR-0008 before assuming it is intentional (RECON §11.3).
- **Two casings for the same blobs:** on-disk `vault.json` is snake_case (`store.rs`); IPC DTOs are
  camelCase. Same data, two encodings (RECON §11.7).
- **Protocol constants are hand-synced, not compile-checked**, between `packages/protocol` and the
  Rust core — silent drift is a real risk (RECON §11.8).
- **Vestigial config:** `RateLimitConfig.accountMaxFailures` / `accountLockoutMs` (and `RL_ACCOUNT_*`
  env vars) remain defined but unused after the per-account lockout was replaced by the backstop
  (RECON §11.6).
- **Gitignored datasets:** the CMU keystroke and Balabit mouse captures are real human data and are
  `.gitignore`d; only loaders + a tiny `cmu-loader.fixture.csv` are committed, and the evaluation
  numbers are quoted from `docs/evaluation/` with provenance, not recomputed here (RECON §9).
- **The README is stale** (claims "Milestone 1, no crypto/vault/risk yet"); trust the code and
  `docs/CERBERUS_HANDOFF.md` over it (RECON §11.1).
- **`cerberus-cli` must never ship in the production binary** and must read the master password from
  stdin/env, never argv — enforced by convention, verified in `bin/cerberus-cli.rs` (CLAUDE.md;
  RECON §4).
