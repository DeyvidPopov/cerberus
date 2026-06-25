# 00 — Reconnaissance Notes (Phase 1)

> **What this file is.** A grounded map of the Cerberus codebase, produced before writing
> the encyclopedia. Everything here was read from the actual source on branch
> `feat/inspector-live-data` (not from the thesis or the README). Each claim carries a
> `file:line` pointer so it can be re-checked. Where the code and the project's own docs
> disagree, this note records **what the code does** and flags the gap.
>
> **Method.** Ten parallel "deep-reader" passes, one per subsystem, each reading its files
> in full and returning structured findings (purpose, entry points, boundaries, exact
> parameters, gotchas, discrepancies). Findings were then reconciled against each other and
> against a hand-read of the manifests and entry points.

---

## 1. What Cerberus is (one paragraph)

Cerberus is a **zero-knowledge password vault** with a **risk-based adaptive authentication**
layer. The desktop app (Tauri: a Rust security core + a React/TypeScript webview) derives all
keys and encrypts all secrets locally; the server (Node/Express + PostgreSQL) only ever stores
ciphertext, hashes, and non-secret telemetry. On top of the vault sits a three-headed guard:
**(1) crypto** (the zero-knowledge vault), **(2) behaviour** (keystroke timing at login + mouse
dynamics in-session), and **(3) context** (new device, impossible travel, time-of-day, recent
failures). At login these fuse into one risk score that maps to **grant / step-up (TOTP) / deny**;
during a session, mouse dynamics are streamed over WebSocket and a spike **locks the vault**.

---

## 2. Repository at a glance

- **255 git-tracked files**; the working tree on this branch adds **~25 untracked files**
  (see §10). Monorepo via npm workspaces (`apps/*`, `packages/*`, `migrations`) + a Cargo
  workspace (the single Rust crate `apps/desktop/src-tauri`).
- File counts by top-level area (tracked): `apps/server` 125, `apps/desktop` 63,
  `docs/adr` 15, `packages/shared-types` 8, `docs/evaluation` 7.

```
cerberus/
├── apps/
│   ├── desktop/                 Tauri app
│   │   ├── src/                 React + TS webview
│   │   │   ├── features/        auth/, vault/, inspector/  (screens)
│   │   │   ├── lib/             tauri IPC, http api, ws, keystroke/mouse capture, otp
│   │   │   └── components/      shadcn-style ui primitives + icons
│   │   └── src-tauri/           Rust security core (the only place secrets live)
│   │       ├── src/crypto/      Argon2id KDF, HKDF, XChaCha20-Poly1305 AEAD, secret newtypes
│   │       ├── src/vault/       credential encrypt/decrypt, VaultManager session, on-disk store, account handshake
│   │       ├── src/commands/    #[tauri::command] IPC surface (12 commands)
│   │       └── src/bin/         cerberus-cli (dev/test crypto oracle)
│   └── server/                  Express API
│       └── src/
│           ├── routes/          thin HTTP surface (auth, vault, enrollment, risk, health)
│           ├── services/        business logic (auth, scoring, risk-decision, totp, geoip, …)
│           ├── risk/            THE THESIS ENGINE: stats, signals, detectors, evaluation
│           ├── repositories/    all SQL (12 repositories), user-scoped
│           ├── ws/              continuous-auth WebSocket
│           ├── middleware/      request-id → cors → auth → rate-limit → validate → error
│           ├── demo/            dev-only demo tooling (gated)
│           └── eval/            dev-only evaluation runners
├── packages/
│   ├── shared-types/            the API/IPC contract (zod schemas + inferred types)
│   └── protocol/               crypto constants only (no logic), mirrored by Rust
├── migrations/                  6 forward-only SQL migrations + runner
└── docs/                        adr/ (0001–0015), threat-model, evaluation/, appendices/, DEMO.md, …
```

---

## 3. Languages, frameworks, and major dependencies

| Layer | Language / runtime | Key dependencies (and why) |
|---|---|---|
| Security core | Rust (edition 2021) | `argon2 0.5` (KDF), `hkdf 0.12` + `sha2 0.10` (key separation), `chacha20poly1305 0.10` (AEAD), `zeroize 1.7` (wipe secrets), `subtle 2.5` (constant-time compare), `getrandom 0.2` (nonces/salts), `serde`/`serde_json` + `base64 0.22` (persistence/wire), `uuid 1` (ids), `thiserror 2` (one error enum). `tauri 2`, `tauri-build 2`, and `time =0.3.47` are **only** pulled by the `desktop` Cargo feature. |
| Webview | React 18 + TypeScript (Vite 6) | `@tauri-apps/api 2` (IPC), `zod` (validate every reply), `qrcode` (TOTP QR), `class-variance-authority` + `clsx` + `tailwind-merge` (ui), `tailwindcss 3.4` + `tailwindcss-animate`. |
| Server | Node + TypeScript (tsx in dev) | `express 4`, `pg 8` (no ORM), `ws 8` (WebSocket), `@node-rs/argon2 2` (hash the *derived auth key* server-side), `maxmind 4` (offline GeoIP), `zod` (boundary validation), workspace deps `@cerberus/shared-types` + `@cerberus/protocol`. |
| Contracts | TypeScript | `@cerberus/shared-types` (zod, consumed as raw `.ts`), `@cerberus/protocol` (no deps). |
| Tooling | — | strict `tsconfig.base.json` (`noUncheckedIndexedAccess`, etc.), flat ESLint (bans `any`, default exports, floating promises), Vitest, `cargo fmt`/`clippy -D warnings`. |

CI (`.github/workflows/ci.yml`) is **three jobs**: (1) hermetic rust-core (`fmt`, `clippy`,
`cargo test --workspace` — no Tauri), (2) desktop Tauri build (`--features desktop`),
(3) typescript (`typecheck`, `lint`, `vitest`) against a **real ephemeral Postgres** service
container, after building `cerberus-cli` for the E2E test.

---

## 4. Entry points

| Process | Entry | Notes |
|---|---|---|
| Rust app | `apps/desktop/src-tauri/src/main.rs:8` → `lib.rs:22 run()` → `commands/mod.rs:384 run()` | Builds the Tauri app, opens `app_data_dir/vault.json`, registers 12 commands; on setup error → `exit(1)` (fail closed). The crypto/vault core is gated *out* of the hermetic build (`#[cfg(feature = "desktop")]`). |
| Rust dev oracle | `apps/desktop/src-tauri/src/bin/cerberus-cli.rs:184` | Subcommand from `argv[1]`, JSON request on **stdin** (never argv), JSON response on stdout. Builds **without** the desktop feature. Used by the E2E test and demo scripts. |
| Server | `apps/server/src/index.ts:13 main()` → `app.ts:39 createApp()` | Loads config, opens GeoIP, creates the pg pool, wraps Express in `http.createServer`, attaches the WS, `listen(config.port)` (default 8080). |
| WebSocket | `apps/server/src/ws/index.ts:100 server.on('upgrade')` | Only `'/ws/continuous-auth'` is served; auth happens at the HTTP upgrade; every other upgrade is `socket.destroy()`. |
| Webview | `apps/desktop/src/main.tsx:12 createRoot(...).render(<App/>)` | `App.tsx` is a two-state shell: `session === null` → `AuthScreen`, else `VaultView`. No router. |
| Migrations | `migrations/migrate.ts main()` (run via `npm run migrate`) | Applies `NNNN_*.sql` in filename order, one transaction each, idempotent via a `schema_migrations` table. |

---

## 5. The boundaries (the four "wires")

### 5a. Tauri IPC surface (Rust ↔ webview) — **12 commands**
Registered at `commands/mod.rs:393-406`; called from `apps/desktop/src/lib/tauri.ts` (every reply
zod-validated). DTOs are `camelCase` on the wire.

`prepare_registration` · `derive_login_auth_key_cmd` · `seal_credential` · `open_credential` ·
`sync_pull_merge` · `unlock` · `lock` · `add_credential` · `list_credentials` ·
`get_credential` · `update_credential` · `delete_credential`.

Crypto material that crosses this boundary: the master password goes **in** (to be derived);
out come the **auth key** (base64), public **KDF params + salt**, the **wrapped vault key**, and
per-credential **ciphertext + nonce**. The encryption key, vault key, and plaintext never leave
Rust. `rotate_master_password` is implemented in Rust (`vault/mod.rs:51`) but **not wired to any
command** — see §11.

### 5b. HTTP API (webview ↔ server)
Called from `apps/desktop/src/lib/api.ts`; defined under `apps/server/src/routes/*`. Middleware
order is fixed: `request-id → cors → json → [per router: authenticate → rate-limit → validate] →
handler → not-found → error`.

- **Auth** (`routes/auth.ts`): `POST /auth/register`, `/auth/prelogin`, `/auth/login`,
  `/auth/step-up/verify`, `/auth/step-up/elevate`; `GET /auth/totp/status`,
  `POST /auth/totp/setup`, `/auth/totp/confirm`; `GET /auth/me`.
- **Vault** (`routes/vault.ts`, all authenticated + rate-limited): `GET /vault/key`,
  `GET|POST /vault/items`, `GET|PUT|DELETE /vault/items/:id`. Not-found is uniform with
  not-owned (no IDOR/existence leak).
- **Enrollment** (`routes/enrollment.ts`): `GET /enrollment/status`, `POST /enrollment/samples`.
- **Risk inspector** (`routes/risk.ts`): `GET /risk/events` — gated
  `authenticate → requireStepUpConfirmed (403) → rate-limit`; output re-validated.
- **Health** (`routes/health.ts`): `GET /health` (no DB, no auth).

Login outcomes render as **distinct, non-leaking** responses (`routes/auth.ts:58-89`):
granted `200` · step-up `200 {status:'step_up_required'}` · denied `403 {error:'denied'}` ·
rate-limited `429` · bad creds `401`. A `risk` breakdown is attached to the `403` **only outside
production**.

### 5c. WebSocket protocol (continuous auth)
Path `/ws/continuous-auth` (`shared-types/src/mouse.ts:243`). Token rides as a
`bearer.<token>` **subprotocol** (browsers can't set Authorization on a WS). Client →
`{type:'mouse_window', featureSchemaVersion, features[9]}`. Server → `{type:'locked', reason:'risk'}`
(all sessions) and `{type:'score', composite, threshold, scored}` (**only** to step-up-confirmed
sessions — the inspector monitor). On a spike: write a `risk_events` row, `sessions.markLocked`,
send `locked`, `close(1000)`.

### 5d. Database access
All SQL lives in `apps/server/src/repositories/*` (12 repositories), each a `createXRepository(db)`
factory of parameterized queries, **every** read/write scoped to `user_id` (IDOR defence).
`repositories/index.ts` is a stale empty `export {}` stub — real wiring is in `app.ts`. Schema is
6 forward-only migrations (§ doc 10).

---

## 6. Mental model: how the four pieces talk

```
            ┌─────────────────────── desktop app (Tauri) ───────────────────────┐
 master pw  │  React webview (TS)            Rust core (src-tauri)               │
 ──────────►│  AuthScreen / VaultView  ──IPC──►  crypto + vault (keys, AEAD)      │
            │  lib/tauri.ts (invoke)            VaultManager (unlock/lock state)  │
            │        │  HTTP (lib/api.ts)                  │ vault.json on disk   │
            └────────┼─────────────────────────────────────────────────────────┘
                     │  WS (lib/ws.ts, mouse windows)
                     ▼
            ┌──────────────── server (Express) ────────────────┐        ┌────────────┐
            │ routes → services → repositories                  │──SQL──►│ PostgreSQL │
            │ risk/ engine (scoring, signals, combiner, policy) │        │ ciphertext │
            │ ws/ continuous-auth                               │        │ + hashes   │
            └──────────────────────────────────────────────────┘        └────────────┘
```

The server is **blind**: it stores `*_encrypted` / `wrapped_*` / `*_hash` columns plus non-secret
metadata (username, KDF params, item types, revisions, risk scores, coarse geo, truncated IPs). The
sole server-side crypto is hashing the already-derived **auth key** for storage (defence in depth).

---

## 7. "Follow a login" — the end-to-end trace (confirmed)

1. **Prelogin** — webview `POST /auth/prelogin {username}` → server returns this user's public KDF
   params + salt, or, for an unknown user, a **deterministic dummy** salt
   `HMAC-SHA256(ENUMERATION_SECRET, username)[..16]` (so unknown users look real; `auth-crypto.ts:69`).
2. **Derive in Rust** — webview calls `derive_login_auth_key_cmd(master_password, salt, params)`;
   Rust runs **Argon2id** (off-thread via `spawn_blocking`) → master key → **HKDF-SHA-256** →
   auth key. Master password + encryption key stay in Rust.
3. **Login** — `POST /auth/login {username, authKey, deviceFingerprintHash, keystrokeSample}`
   (+ `X-Demo-Geo` header only in dev). Server `auth.ts login()`:
   - verifies the auth key against the stored **Argon2id hash** (constant-time; a fixed dummy hash
     equalizes timing for unknown users);
   - enrols/looks up the device (`xmax=0` → new device);
   - **behavioural sub-score**: decrypt the active baseline, score the keystroke vector via
     **Mahalanobis → χ²** (`scorer.ts`); fail-closed to score `1` ("missing") if telemetry is
     absent/mismatched;
   - **contextual sub-scores**: new-device, geovelocity, time-of-day, failure-velocity
     (`contextual-risk.ts`);
   - **combine** (weighted-linear, not normalized) → composite; **band** it (`policy.ts`) → grant /
     step-up / deny; apply backstops + the newcomer **bootstrap-grant** rule; write a `risk_events`
     row.
4. **Outcome** — granted → session token + wrapped vault key returned; step-up → a TOTP challenge;
   denied → generic `403`.
5. **TOTP step-up** (if required) — `POST /auth/step-up/verify {challengeToken, code}` →
   RFC 6238 verify (±1 step) with a monotonic replay watermark → session.
6. **Unlock** — webview `unlock(master_password)` (Rust re-derives keys, decrypts the vault) and
   `sync_pull_merge` pulls server blobs, decrypting under the **server** vault key and
   re-encrypting under the **local** vault key (plaintext never leaves Rust).
7. **In session** — `VaultView` opens the **continuous-auth WS**, streams mouse windows; an EWMA
   spike → server locks the session and tells the client to lock.

---

## 8. Load-bearing parameters — **all confirmed against code**

The thesis/prompt's headline numbers were checked against source. They match. Record the *real*
values, and note the two easy-to-conflate distinctions.

| Thing | Value (from code) | Where |
|---|---|---|
| Argon2id (client master-key KDF) | memory **229 376 KiB = 224 MiB**, iterations **3**, parallelism **1**, 32-byte output, Argon2 v19, `KDF_VERSION=1` | `crypto/kdf.rs:39-43`; `packages/protocol/src/index.ts:15-22` |
| HKDF | **SHA-256**, salt = none; labels `cerberus/auth-key/v1`, `cerberus/encryption-key/v1` | `crypto/kdf.rs:21-23,84` |
| Vault AEAD | **XChaCha20-Poly1305**, 24-byte random nonce/op, 16-byte tag | `crypto/aead.rs:9,15` |
| AAD labels | `cerberus/vault-key-wrap/v1`, `cerberus/credential/v1` | `crypto/mod.rs:29`; `vault/mod.rs:30` |
| **Server** auth-key hash (≠ client KDF) | Argon2id **19 456 KiB ≈ 19 MiB**, t **2**, p **1** | `services/auth-crypto.ts:20-25` |
| Baseline / TOTP at-rest cipher (≠ vault AEAD) | **AES-256-GCM**, 12-byte IV, 16-byte tag, AAD bound to user id | `services/baseline-crypto.ts:14-18`; `services/secretbox.ts:8-11` |
| Risk bands | step-up **0.30**, deny **0.70** (composite ≥ threshold ⇒ escalate; ties escalate) | `risk/config.ts:283-286` |
| Combiner weights (**not** normalized, sum 1.9) | behavioral **0.5**, newDevice **0.35**, geovelocity **0.5**, timeOfDay **0.2**, failureVelocity **0.35** | `risk/config.ts:255-261` |
| Behavioral scorer | Mahalanobis D² → χ² CDF; **dof = full feature dimension** (`3n-2` for n keystrokes) | `scorer.ts:76-78` |
| Covariance regularization | Ledoit-Wolf shrinkage (data-driven ρ) toward `μI`, then diagonal ridge **`COVARIANCE_RIDGE = 1e-6`** | `baseline-model.ts:141-157`; `risk/config.ts:26` |
| Enrollment thresholds | keystroke **10** samples, mouse **12** (`MIN_ENROLLMENT_SAMPLES` / `MOUSE_MIN_ENROLLMENT_SAMPLES`) | `risk/config.ts:15,337` |
| TOTP | RFC 6238 HMAC-SHA1, **6** digits, **30 s**, **±1** step skew, 5-min challenge TTL | `risk/config.ts:317-322` |
| Continuous auth | EWMA **α = 0.5**, spike threshold **0.85** | `risk/config.ts:354-358`; `continuous-auth.ts:17-24` |
| Keystroke feature schema | `FEATURE_SCHEMA_VERSION=1`, dim `3n-2` (holds n, down-down n-1, up-down n-1), `MIN_KEYSTROKES=2` | `shared-types/src/behavioral.ts:33,83-108` |
| Mouse feature schema | `MOUSE_FEATURE_SCHEMA_VERSION=1`, **9** dims, window **32**/step **16**, pause ≥ **120 ms** | `shared-types/src/mouse.ts:18-52` |
| Brute-force backstop | per-IP hard cap **50** (→ rate-limited), per-account cap **20** (→ step-up), 15-min window | `risk/config.ts:301-305` |
| Offline detectors | iForest **100** trees / subsample **256**; one-class SVM **ν=0.1**, γ=1/d, tol 1e-4; seed **20240601** | `risk/config.ts:51-71` |

> ⚠️ **The "~0.5 s / 521 ms" Argon2id timing is a code comment, not a checked-in measurement** —
> the benchmark test is `#[ignore]`d (`kdf.rs:226-248`). To confirm, run
> `cargo test --release -- --ignored`.

---

## 9. Reported evaluation numbers (from `docs/evaluation/` + ADRs)

These are the committed, reproducible results (regenerated by `npm run eval:*`, seed `20240601`).
The underlying datasets (CMU keystroke, Balabit mouse) are **gitignored** (real human captures), so
the encyclopedia will quote these figures *with provenance*, not recompute them.

| Benchmark | Mahalanobis (deployed) | One-class SVM | Isolation Forest |
|---|---|---|---|
| Keystroke EER (CMU, 51 subj, dim 31) | **13.42% ± 6.73%** | 10.69% ± 7.18% | 8.89% ± 6.68% |
| Mouse EER (Balabit, 10 users, dim 9) | **38.18% ± 7.82%** | 35.94% ± 2.86% | 34.95% ± 6.50% |

Behavioral-only threshold tuning (`docs/evaluation/threshold-tuning.md`): behavioral χ² EER on the
held-out split **19.25%**; the empirically tuned step-up point was **0.29** (genuine FRR 6.98%,
behavioral-only FAR 48.84%) — the shipped config **keeps 0.30** as a clean value (documented, not a
bug; `risk/config.ts:267-277`). Published K&M references cited for comparison: Mahalanobis ≈11.0%,
one-class SVM ≈10.2% (`eval/run-keystroke-eval.ts:27-30`).

---

## 10. Branch & working-tree state (important for accuracy)

We are on `feat/inspector-live-data`. The git-tracked tree omits files that exist on disk and are
**fully wired** — the encyclopedia must document the **working tree**, not just `git ls-files`.
Untracked (new) files to cover:

- **Frontend inspector** (replaces the deleted `features/vault/RiskInspector.tsx`):
  `features/inspector/{RiskDashboard,charts,icons}.tsx`, `{illustrative,live,model,theme}.ts`.
- **Frontend auth/vault**: `features/auth/TotpOnboarding.tsx` (replaces deleted
  `vault/TotpEnrollment.tsx`), `features/vault/OtpField.tsx`, `lib/otp.ts` (local per-item TOTP).
- **Server**: `services/risk-explanation.ts` (the dev-gated deny breakdown), `demo/geovelocity.ts`,
  plus tests `routes/{deny-explanation,geovelocity}.test.ts`.
- **Docs**: `docs/appendices/appendix-B.md`, `-C.md`, `-D.md`, `docs/schema-reference.md`,
  `docs/design/inspector/`.

Deleted (per `git status`): `features/vault/RiskInspector.{tsx,test.tsx}`,
`features/vault/TotpEnrollment.{tsx,test.tsx}` — superseded; no dangling imports.

---

## 11. Discrepancies & honest gaps (to flag, not smooth over)

1. **README is badly stale.** `README.md:10-12` says *"Milestone 1 — monorepo scaffold + CI …
   no crypto, vault, or risk logic yet."* The code implements the **complete** system
   (crypto core, vault CRUD, zero-knowledge login, behavioral + contextual risk, TOTP step-up,
   continuous-auth WS). `docs/CERBERUS_HANDOFF.md` declares M1–M12 complete. **Highest-priority
   doc gap.** Every reader flagged it.
2. **`unlock` is a *synchronous* Tauri command** (`commands/mod.rs:322`) — it runs Argon2id on the
   invoking thread, unlike the five async `spawn_blocking` commands (`prepare_registration`,
   `derive_login_auth_key_cmd`, `seal_credential`, `open_credential`, `sync_pull_merge`). Flagged in the handoff as a
   known open item. Whether Tauri runs sync commands off the webview thread (so the UI doesn't
   actually freeze) needs confirming in doc 11.
3. **VaultView does not push edits to the server.** `lib/sync.ts` has `pushNewItem`/`pushUpdatedItem`
   but `VaultView` only mutates the local Rust vault (`addCredential`/`updateCredential`) and only
   ever **pulls** on unlock. Could be intentional for this branch or a regression — confirm against
   ADR-0008.
4. **No pending-migration startup guard.** A stale dev DB missing a migration surfaces as a 500
   (handoff lists this as recommended-but-not-built).
5. **ADR prose conflict on trust-proxy.** ADR-0007 says the app does *not* set Express trust proxy;
   ADR-0011 says it *is* configured via `TRUST_PROXY`. `app.ts:43` does `app.set('trust proxy', …)`,
   default `false`. ADR-0011 supersedes; note it.
6. **Vestigial config.** `RateLimitConfig.accountMaxFailures` / `accountLockoutMs` (and the
   `RL_ACCOUNT_*` env vars) remain defined but are unused — the M4 per-account lockout was removed in
   favour of the backstop.
7. **Two serialization casings for the same blobs.** On-disk `vault.json` is **snake_case**
   (`store.rs`), IPC DTOs are **camelCase** — conceptually the same data, two encodings.
8. **Protocol constants are duplicated, not compile-checked.** `packages/protocol` (TS) and the Rust
   core hold the same crypto constants by hand-sync; drift would silently break auth/decrypt.
9. **`tauri.conf.json` CSP `connect-src` whitelists plaintext `http://localhost:8080`** (dev) — note
   it is unencrypted transport, acceptable for local dev.

---

## 12. Open questions for Phase 2 (cheap to resolve while writing)

- Confirm Tauri's threading for the sync `unlock` command (does the UI freeze?).
- Confirm whether `email_otp` (allowed by a CHECK constraint + `ChallengeMethod` type) is wired
  anywhere — appears to be schema headroom (`step_up_challenges`).
- Confirm `cerberus-cli` is excluded from the production bundle (auto-discovered bin, no `[[bin]]`).
- Read `docs/schema-reference.md` and `docs/appendices/*` — they may already cover doc 10 / doc 14
  ground and should be cross-linked rather than duplicated.
- Verify the live `risk-inspector` endpoint never returns raw feature vectors (privacy invariant).

---

## 13. Proposed encyclopedia → source mapping

| Doc | Primary sources (verified present) |
|---|---|
| `01-overview` | PROJECT.md §1, threat-model, README (with the staleness caveat) |
| `02-architecture` | this §6/§7, `index.ts`, `app.ts`, `main.tsx`, `lib.rs` |
| `03-repository-map` | the working-tree tree in §2 + §10 (every dir, untracked included) |
| `04-cryptographic-core` | `crypto/{kdf,aead,secret,mod}.rs`, `error.rs`, `protocol`, ADR-0001/0005 |
| `05-vault-and-sync` | `vault/{mod,manager,store,account}.rs`, `commands/mod.rs`, `lib/{auth,sync,tauri}.ts`, ADR-0006/0007/0008 |
| `06-behavioral-engine` | `shared-types/{behavioral,mouse}.ts`, `lib/{keystroke,mouse-capture}.ts`, `risk/{baseline-model,scorer}.ts`, `services/{enrollment,scoring}.ts`, ADR-0002/0009 |
| `07-decision-and-policy` | `risk/{combiner,policy,config}.ts`, `risk/signals/*`, `services/{risk-decision,contextual-risk,totp,totp-service,risk-explanation}.ts`, ADR-0011/0012 |
| `08-continuous-auth` | `risk/continuous-auth.ts`, `services/continuous-auth.ts`, `ws/index.ts`, `lib/ws.ts`, ADR-0013 |
| `09-server-and-api` | `routes/*`, `middleware/*`, `services/auth*`, `config.ts`, shared-types schemas |
| `10-database` | `migrations/*.sql`, `repositories/*`, `docs/schema-reference.md` |
| `11-frontend` | `App.tsx`, `features/*`, `lib/*`, `components/*`, ADR-0015 |
| `12-build-run-test` | `package.json`(s), `Cargo.toml`, `ci.yml`, `DEV_RUNBOOK.md`, `DEMO.md`, `demo/*`, `eval/*` |
| `13-glossary` | terms gathered across all docs |
| `14-algorithms-deep-dive` | `risk/{mahalanobis,chi-squared,baseline-model,eer,evaluation,threshold-tuning}.ts`, `detectors/*`, `geo/*`, `docs/evaluation/*`, `docs/appendices/*` |

---

## 14. Surprises worth your attention

- The project is **far more complete** than its own README admits (M1–M12). The README status line
  should arguably be fixed; say the word and I'll correct it alongside the encyclopedia.
- The **inspector dashboard** (a sizable, live-data feature on this branch) is **untracked** — not
  yet committed. I'll document it as present in the working tree.
- There are **already** `docs/appendices/{B,C,D}.md` and `docs/schema-reference.md` (untracked). I'll
  read and **reuse/cross-link** them rather than duplicate — flagging if any conflict with the code.
- Two genuinely subtle, security-relevant behaviours I'll make sure beginners understand: the
  **fail-closed** path (omitting telemetry can't bypass the behavioral check — it denies) and the
  **newcomer bootstrap-grant** (so a first-time user can get in to set up TOTP).
