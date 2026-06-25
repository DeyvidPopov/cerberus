# 12 — Build, run, test: dev tooling and scripts

> Cross-links: [Architecture](02-architecture.md) · [Repository map](03-repository-map.md) ·
> [Cryptographic core](04-cryptographic-core.md) · [Server and API](09-server-and-api.md) ·
> [Database](10-database.md) · [Behavioral engine](06-behavioral-engine.md) ·
> [Continuous auth](08-continuous-auth.md) · [Algorithms deep-dive](14-algorithms-deep-dive.md) ·
> [Glossary](13-glossary.md)

---

## 1. In plain English

This chapter is the "how do I actually run it" guide. Cerberus is two programs that talk to
each other: a **desktop app** (a native window built with Tauri — a Rust core plus a web-page
UI) and a **server** (a Node/Express web service backed by PostgreSQL, a relational database).
To work on it you install dependencies once, start a database, run the migrations (scripts that
build the database tables), then run the server and the desktop app in two terminals. To prove
your change is good before you push, you run the same checks the project's automation
(Continuous Integration, "CI") runs: format/lint, type-check, and tests.

Two things make this project's tooling unusual, and both are deliberate:

1. **The crypto core builds and tests without Tauri.** The security-critical Rust (key
   derivation, encryption) is compiled and unit-tested *on its own*, with no GUI toolkit
   attached. That keeps the test gate fast and portable ("hermetic"). The full native app is a
   separate, heavier build behind a Cargo feature flag named `desktop`.
2. **Tests use a real, throwaway PostgreSQL — never a fake.** Every test run creates a fresh
   database, applies all migrations, runs, then drops it. This catches bugs that mocks hide
   (a missing column, a constraint, an SQL typo). The catch: the test runner does **not** read
   your `.env` file, so you must hand it a database URL via the `TEST_DATABASE_URL` environment
   variable or tests fail to connect.

On top of running the app, the repo ships two families of **developer-only** helpers: `demo:*`
(seed a ready-to-demo account, force a step-up on cue) and `eval:*` (reproduce the thesis's
accuracy numbers from research datasets). Both are hard-walled off from production.

---

## 2. Where it lives

```
cerberus/
├── package.json                    Root workspace scripts (the commands you type)
├── README.md                       Install + run quickstart (status line now reads "M1–M12, implemented end-to-end")
├── DEV_RUNBOOK.md                  Windows/PowerShell copy-paste runbook (authoritative for local)
├── .env.example                    Every env var, documented (copy to .env)
├── tsconfig.base.json              Strict TypeScript compiler options (shared by all TS packages)
├── eslint.config.mjs               Flat ESLint config (bans any / default exports / floating promises)
├── vitest.config.ts                Test runner config (node default env, jsdom per-file)
├── .github/workflows/ci.yml        The three CI jobs (rust-core, desktop, typescript)
├── migrations/
│   └── package.json                `migrate` script → migrate.ts
├── apps/
│   ├── desktop/
│   │   ├── package.json            dev / build / typecheck / test / tauri:dev scripts
│   │   └── src-tauri/Cargo.toml    Rust crate; `desktop` feature; two binaries; `time` pin
│   └── server/
│       ├── package.json            dev / test / eval:* / demo:* scripts
│       └── src/
│           ├── config.ts           env → ServerConfig; production-refusal + demo gating
│           ├── test-support/postgres.ts   ephemeral-Postgres harness (createTestDb)
│           ├── demo/               DEV-ONLY demo tooling (seed/reset/impostor/geovelocity)
│           └── eval/               DEV-ONLY evaluation runners (keystroke/mouse/tune/integrated)
└── docs/DEMO.md                    The demo tooling guide (dev-gating, knobs, refusal)
```

This doc covers those files. It does **not** re-explain the crypto, scoring, or schema
themselves — see the linked chapters for those.

---

## 3. File-by-file

### Root `package.json` — the command menu
[package.json](../../package.json). One sentence: declares the npm **workspaces** (`apps/*`,
`packages/*`, `migrations`) and the top-level scripts you type from the repo root.

This is a *monorepo* (one git repo holding several packages). npm workspaces means a single
`npm install` at the root installs and links every sub-package. The root scripts mostly delegate
into a workspace with `--workspace @cerberus/<name>`:

| Root script | What it runs | Notes |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit` in every workspace `--if-present` | Type-check only, emits nothing |
| `npm run lint` | `eslint .` | Flat config, see below |
| `npm run lint:fix` | `eslint . --fix` | Auto-fix |
| `npm test` | `vitest run` | One run (not watch); needs Postgres (§7) |
| `npm run build` | `build` in every workspace `--if-present` | |
| `npm run migrate` | migrate in `@cerberus/migrations` | Apply pending SQL migrations |
| `npm run dev:server` | `dev` in `@cerberus/server` | Express in watch mode |
| `npm run dev:desktop` | `dev` in `@cerberus/desktop` | **Vite webview only**, no Rust |
| `npm run dev:app` | `tauri:dev` in `@cerberus/desktop` | The **real native app** (Rust + webview) |
| `npm run build:cli` | `cargo build --bin cerberus-cli …` | Builds the crypto oracle binary |
| `npm run demo:seed` / `demo:reset` / `demo:impostor` / `demo:geovelocity` | server `demo:*` | DEV-only (§8) |

`engines.node` is `>=20.11`; the package is `private` and `type: module` (ES modules everywhere).
`eval:*` scripts are **not** exposed at root — run them in the server workspace (§9).

### `apps/server/package.json`
[apps/server/package.json](../../apps/server/package.json). The Express API workspace
(`@cerberus/server`).

- `dev`: `tsx watch --env-file-if-exists=../../.env src/index.ts` — `tsx` runs TypeScript directly
  (no build step); `watch` restarts on edit; `--env-file-if-exists` loads `.env` if present (a
  native Node flag, **not** the `dotenv` library — there is no `dotenv` dependency).
- `start`: same without `watch` (production-style run).
- `typecheck`: `tsc --noEmit`. `test`: `vitest run`.
- `eval:keystroke|mouse|tune|integrated`: research runners (`tsx src/eval/run-*.ts`) — §9.
- `demo:seed|reset|impostor|geovelocity`: `tsx --env-file-if-exists … src/demo/*.ts` — §8.
- Runtime deps worth noting: `express`, `pg` (raw PostgreSQL driver — **no ORM**), `ws`
  (WebSocket), `@node-rs/argon2` (server-side hash of the already-derived auth key — defence in
  depth, see [crypto core](04-cryptographic-core.md)), `maxmind` (offline GeoIP lookup), `zod`
  (validate every boundary), and the workspace contracts `@cerberus/shared-types` /
  `@cerberus/protocol`.

### `apps/desktop/package.json`
[apps/desktop/package.json](../../apps/desktop/package.json). The webview frontend workspace
(`@cerberus/desktop`).

- `dev`: `vite` — start the Vite dev server (browser webview only, no Rust → cannot derive keys).
- `build`: `tsc --noEmit && vite build` — type-check, then bundle the static `dist/` that Tauri
  embeds into the native app.
- `tauri:dev`: **`tauri dev --features desktop -- --bin cerberus-desktop`** — the full app. The
  two extra flag groups matter (see gotcha in §10): `--features desktop` turns on the Tauri
  runtime in the Rust crate, and `--bin cerberus-desktop` disambiguates which of the crate's two
  binaries to run.
- React 18 + TypeScript on Vite 6; `@tauri-apps/api` for IPC; `zod` to validate every reply from
  Rust; `qrcode` for the TOTP enrollment QR; shadcn-style UI deps (`class-variance-authority`,
  `clsx`, `tailwind-merge`, `tailwindcss`).

### `apps/desktop/src-tauri/Cargo.toml` — the hermetic/desktop split lives here
[Cargo.toml](../../apps/desktop/src-tauri/Cargo.toml). The single Rust crate `cerberus-desktop`.
This file is the source of truth for the build split, so read it closely:

- `[lib]` `cerberus_desktop` (`src/lib.rs`) — the reusable crypto/vault core.
- `[[bin]]` `cerberus-desktop` (`src/main.rs`) with `required-features = ["desktop"]` — the
  native app binary only builds when the `desktop` feature is on.
- A **second** binary, `cerberus-cli`, is auto-discovered from `src/bin/` (no `[[bin]]` entry).
  It builds **without** `desktop` (pure core), which is why `npm run build:cli` works in CI with
  no GUI libraries installed.
- `[features] default = []`; `desktop = ["dep:tauri", "dep:tauri-build", "dep:time"]`. The comment
  explains the `time` pin: `dep:time` hard-pins the transitive `time` crate to **`=0.3.47`**
  because `time >=0.3.48` conflicts with `tauri-utils 2.9.2` (Rust error `E0119`). The pin is
  gated to `desktop` so the hermetic core never even pulls `time`.
- Crypto deps (always present, never behind a feature): `argon2`, `hkdf`, `sha2`,
  `chacha20poly1305`, `zeroize`, `subtle`, `getrandom` — see [crypto core](04-cryptographic-core.md).
- `[lints] workspace = true` — inherits the workspace-wide lint policy (clippy denies warnings).

### `migrations/package.json`
[migrations/package.json](../../migrations/package.json). `migrate`:
`tsx --env-file-if-exists=../.env migrate.ts` — applies the ordered `.sql` files. Forward-only,
idempotent via a `schema_migrations` table. See [Database](10-database.md) for the runner and the
six migrations.

### `.env.example` — every environment variable, documented
[.env.example](../../.env.example). The canonical list. Copy to `.env` (gitignored; never commit).
Full table in §6.

### `config.ts` — env → typed config, with the production guards
[apps/server/src/config.ts](../../apps/server/src/config.ts). `loadConfig()` reads the
environment once at startup into a `ServerConfig`. This is where the **fail-closed** production
refusals and **demo-knob gating** live — §6 and §8.

### `vitest.config.ts`, `eslint.config.mjs`, `tsconfig.base.json`
The three tooling configs. Covered in §6 (tooling) below.

### `test-support/postgres.ts` — the ephemeral-database harness
[apps/server/src/test-support/postgres.ts](../../apps/server/src/test-support/postgres.ts).
`createTestDb()` makes the real-Postgres-per-run guarantee true. §7.

### Demo and eval files
`demo/{seed,reset,impostor,geovelocity,core,env,samples,cli}.ts` and
`eval/run-{keystroke,mouse,threshold-tuning,integrated-analysis}.ts`. §8 and §9.

**Skipped as trivial here:** `apps/desktop/vite.config.ts`, `tailwind.config.js`,
`postcss.config.js` (build-tool plumbing covered in [Frontend](11-frontend.md)); the individual
`.test.ts` files (their subject matter belongs to their feature chapters).

---

## 4. How it works — install, run, test, in order

### 4a. Install (once)

```bash
npm install        # installs + links every workspace (root + apps/* + packages/* + migrations)
cargo fetch        # (optional) pre-fetch Rust crates; otherwise fetched on first build
cp .env.example .env   # then edit DATABASE_URL and generate real secrets
```

Prerequisites (from [README.md](../../README.md) and [DEV_RUNBOOK.md](../../DEV_RUNBOOK.md)):
Node ≥ 20.11, Rust stable (edition 2021) with `clippy` + `rustfmt`, and PostgreSQL ≥ 14. To build
the *native* window you also need platform webview libraries — on Windows, WebView2 + the MSVC
C++ build tools; on Linux, the GTK/WebKit `-dev` packages the CI `desktop` job installs.

> ℹ️ The runbook documents the developer's machine concretely: PostgreSQL 18 on **port 5433**
> (trust auth, no Docker), so its `DATABASE_URL` uses `5433`. The defaults elsewhere in the repo
> assume the standard **5432**. If your Postgres is on 5432, change the port in `.env`. This is a
> per-machine detail, not a project requirement.

### 4b. Bring up the database, then migrate

```bash
# create role + db (example, port 5433 from the runbook)
psql -U postgres -h 127.0.0.1 -p 5433 -c "CREATE ROLE cerberus LOGIN PASSWORD 'cerberus';"
psql -U postgres -h 127.0.0.1 -p 5433 -c "CREATE DATABASE cerberus OWNER cerberus;"

npm run migrate     # applies all NNNN_*.sql in order against DATABASE_URL
```

Why migrate first? **The running database must be migrated before the new code runs.** A query
against a column a migration hasn't added yet surfaces as a 500 at runtime (there is no
pending-migration startup guard — see [PROJECT.md](../../PROJECT.md) rules and recon §11.4).
Tests don't hit this because the harness re-applies every migration on a fresh DB each run.

### 4c. Run the two processes (two terminals)

There is no single root "run everything" command (no `concurrently` dependency by design).

```bash
# Terminal 1 — the API
npm run dev:server
curl http://localhost:8080/health   # -> {"status":"ok","uptimeSeconds":…,"timestamp":…}

# Terminal 2 — the native desktop app (full crypto works here)
npm run dev:app
```

`npm run dev:app` makes Tauri start Vite (pinned to port 1420 to match the `devUrl` in
`tauri.conf.json`), compile the Rust core (first build ~1–2 min), and open the native window.
Register/login/unlock all work because key derivation runs in the Rust core.

The webview-only variant `npm run dev:desktop` serves the UI at `http://localhost:1420` for fast
UI iteration, but a browser webview **cannot derive keys** — use `dev:app` for the real flow. The
UI reads `VITE_API_BASE_URL` at build time (defaults to `http://localhost:8080`).

### 4d. The "register → enroll → login → step-up" walk

The [DEV_RUNBOOK](../../DEV_RUNBOOK.md) maps each UI action to the Tauri IPC command it
exercises (register → `prepare_registration`; unlock → `derive_login_auth_key_cmd` then `unlock`;
add → `add_credential`; etc.). The end-to-end behavioral flow: register (bootstrap-granted),
then lock+login repeatedly typing the master password each time to enroll a baseline (`dev/.env`
lowers `MIN_ENROLLMENT_SAMPLES` so it activates after a few logins instead of the default 10),
then a "new device" login → `step_up_required` → enter the TOTP code → granted. Suppressing the
keystroke sample on an active account is correctly **denied** (fail closed). See
[Behavioral engine](06-behavioral-engine.md) and [Decision and policy](07-decision-and-policy.md).

---

## 5. The three CI jobs

[.github/workflows/ci.yml](../../.github/workflows/ci.yml) runs on every push to `main` and every
pull request; a red pipeline blocks merge. `concurrency` cancels superseded runs on the same ref.
Three independent jobs:

```mermaid
flowchart TD
    PR[push / pull_request] --> A
    PR --> B
    PR --> C
    A["rust-core (ubuntu-latest)<br/>cargo fmt --check<br/>clippy -D warnings (default features)<br/>cargo test --workspace<br/>HERMETIC: no Tauri, no system deps"]
    B["desktop (ubuntu-22.04)<br/>apt install webkit/gtk libs<br/>npm ci<br/>build frontend dist<br/>cargo build -p cerberus-desktop --features desktop<br/>clippy --features desktop"]
    C["typescript (ubuntu-latest)<br/>postgres:16 service container<br/>cargo build --bin cerberus-cli (for E2E)<br/>npm run typecheck / lint / test"]
```

1. **`rust-core` — the fast, always-green security gate (hermetic).** Installs the Rust toolchain
   with `clippy` + `rustfmt`, then runs `cargo fmt --all --check`, `cargo clippy --workspace
   --all-targets -- -D warnings`, and `cargo test --workspace`. Because the `desktop` feature is
   off, the Tauri-gated `commands` module and the `cerberus-desktop` binary are **not** compiled
   — only the pure crypto/vault core and its tests. No system libraries, no Node, no database.

2. **`desktop` — the heavy native build.** On `ubuntu-22.04` it `apt-get install`s the webview
   stack (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, etc.), runs `npm ci`, then
   **builds the frontend dist first** (`npm run build --workspace @cerberus/desktop`) because
   Tauri's `generate_context!` macro embeds `dist/` at compile time — no dist, no build. Then
   `cargo build -p cerberus-desktop --features desktop` and a `clippy` pass with the feature on.

3. **`typescript` — typecheck, lint, tests against a real Postgres.** Declares a `postgres:16`
   **service container** on port 5432 with a health-check, and sets two env vars for the job:
   `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres` and
   `CERBERUS_CLI_BIN=target/debug/cerberus-cli`. Steps: install the Rust toolchain (needed only to
   build the crypto CLI for the end-to-end test), `npm ci`, **`cargo build --bin cerberus-cli`**,
   then `npm run typecheck`, `npm run lint`, `npm test`. The headline E2E
   (`apps/server/src/sync.e2e.test.ts`) drives the *real* Rust crypto through that CLI oracle.

### Running the same checks locally

```bash
# Job 1 (hermetic core)
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Job 2 (native build)
npm run build --workspace @cerberus/desktop
cargo build -p cerberus-desktop --features desktop

# Job 3 (TypeScript)
npm run typecheck
npm run lint
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres npm test
```

---

## 6. Environment variables and the production-refusal guards

All variables live in [.env.example](../../.env.example) and are parsed by `loadConfig()` in
[config.ts](../../apps/server/src/config.ts). `.env` is loaded only because the `dev`/`start`/
`migrate` scripts pass Node's `--env-file-if-exists` flag — there is no `dotenv` library, and in
CI the flag is a no-op because the environment is supplied directly.

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Express listen port |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` — gates demo knobs + prod refusals |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/cerberus` | Server + migration runner connection |
| `ENUMERATION_SECRET` | `dev-only-enumeration-secret-change-me` | Keys the user-enumeration mitigation (ADR-0007); **prod refuses the dev default** |
| `SESSION_TTL_MS` | `86400000` (24h) | Session lifetime |
| `RL_IP_WINDOW_MS` / `RL_IP_MAX` | `900000` / `100` | Per-IP login/prelogin rate limit |
| `RL_ACCOUNT_MAX_FAILURES` / `RL_ACCOUNT_LOCKOUT_MS` | `5` / `900000` | **Vestigial** — parsed but unused (M4 per-account lockout replaced by the backstop; recon §11.6) |
| `RL_VAULT_WINDOW_MS` / `RL_VAULT_MAX` | `900000` / `600` | Per-user authenticated vault-sync rate limit (no `.env.example` line; defaulted in code) |
| `BASELINE_ENC_KEY` | all-zeros hex (dev) | 32-byte key encrypting behavioral baselines at rest; **prod refuses an empty value** |
| `MIN_ENROLLMENT_SAMPLES` | `10` | Keystroke samples before a baseline activates — **DEMO knob** (§8) |
| `GEOIP_DB_PATH` | unset (no code default; `.env.example` suggests `apps/server/data/GeoLite2-City.mmdb`) | Offline MaxMind DB; unset/missing ⇒ geovelocity stays neutral |
| `TRUST_PROXY` | `false` | Express trust-proxy hops/bool/preset (ADR-0011) |
| `FAILURE_VELOCITY_WINDOW_MIN` | `15` | Window for the failure-velocity signal |
| `BAND_STEP_UP` / `BAND_DENY` | `0.30` / `0.70` | Composite-score bands → grant / step-up / deny |
| `BACKSTOP_IP_CAP` / `BACKSTOP_ACCOUNT_CAP` | `50` / `20` | Brute-force backstop caps |
| `MOUSE_MIN_ENROLLMENT_SAMPLES` | `12` | Mouse windows before the in-session baseline activates — **DEMO knob** (§8) |
| `CONTINUOUS_AUTH_EWMA_ALPHA` | `0.5` | In-session score smoothing — **DEMO knob** (§8) |
| `CONTINUOUS_AUTH_SPIKE_THRESHOLD` | `0.85` | In-session spike→lock threshold — **DEMO knob** (§8) |
| `VITE_API_BASE_URL` | `http://localhost:8080` | API URL baked into the webview at build time |
| `CORS_ALLOWED_ORIGINS` | Vite + Tauri origins | Comma-separated allowed cross-origin callers |
| `TEST_DATABASE_URL` | (see §7) | **Tests only** — admin URL the harness uses to CREATE/DROP the ephemeral DB |
| `DEMO_ALLOW_NONLOCAL_DB` | unset | Set `yes` to let demo scripts touch a non-local throwaway DB |
| `DEMO_API_BASE_URL` | falls back to `VITE_API_BASE_URL` then `:8080` | URL the impostor helper posts to |

### The "fail closed" production refusals (fail closed, security invariant)

`loadConfig()` refuses to start a production server with insecure defaults — never silently weaken.

- **`ENUMERATION_SECRET`** ([config.ts:196-200](../../apps/server/src/config.ts)): if
  `NODE_ENV === 'production'` and the value equals the public dev default, it throws
  `'ENUMERATION_SECRET must be set in production (ADR-0007).'`. Otherwise an attacker who knows
  the dev secret could recompute the dummy salts used to make unknown users look real, and
  enumerate accounts.
- **`BASELINE_ENC_KEY`** (`loadBaselineKey`, [config.ts:181-190](../../apps/server/src/config.ts)):
  if unset/empty in production it throws `'BASELINE_ENC_KEY must be set in production (ADR-0009).'`.
  In dev it falls back to a known all-zeros key. `decodeKey` requires exactly 32 bytes (64 hex
  chars, or base64) or throws.

### The demo-knob gating (§8 explains the scripts; the *config* gating is here)

The four demo knobs (`MIN_ENROLLMENT_SAMPLES`, `MOUSE_MIN_ENROLLMENT_SAMPLES`,
`CONTINUOUS_AUTH_EWMA_ALPHA`, `CONTINUOUS_AUTH_SPIKE_THRESHOLD`) are read through
`demoIntFromEnv` / `demoFloatFromEnv`, which call `demoOverridesAllowed(nodeEnv)` — true for
**every** environment except `production`. In production the env var is **ignored**, the secure
default applies, and `warnIgnoredInProd` logs `[config] ignoring DEMO-only override <name> in
production…`. When a non-default override *is* honored (non-prod), it logs `[config] DEMO-only
override active (NON-PRODUCTION): <name>=<value> …` so it is never silent. A demo knob therefore
**cannot** weaken a shipped binary.

---

## 7. Tests: real ephemeral Postgres, and the `TEST_DATABASE_URL` gotcha

Repository and integration tests run against a **real** PostgreSQL, not mocks (a project testing
gate). The mechanism is
[test-support/postgres.ts](../../apps/server/src/test-support/postgres.ts):

`createTestDb()` does, in order:
1. Pick the **admin** connection: `process.env.TEST_DATABASE_URL` or the local default
   `postgres://postgres:postgres@127.0.0.1:5432/postgres`.
2. Generate a unique throwaway name `cerberus_test_<16 hex chars>` from `randomBytes(8)` (a
   controlled identifier, not user input — DDL like `CREATE DATABASE` can't be parameterized).
3. Connect as admin, `CREATE DATABASE "<name>"`, disconnect.
4. Open a pool to the new DB and apply **all** migrations: it reads every `*.sql` in `migrations/`,
   sorts by filename, concatenates, and runs them in one `pool.query`.
5. Return `{ pool, teardown }`; `teardown` ends the pool and `DROP DATABASE … WITH (FORCE)`.

Because every run re-applies every migration on a brand-new database, tests can never be bitten by
a stale schema — the failure mode that *does* bite a stale dev DB (a 500 from a missing column).

### The gotcha (user memory): `vitest` does not load `.env`

The `npm test` / `vitest run` command does **not** pass `--env-file-if-exists`, so it does **not**
read your `.env`. If `TEST_DATABASE_URL` is unset, the harness falls back to
`postgres:postgres@127.0.0.1:5432/postgres`; if your Postgres isn't there (e.g. it's on 5433),
the tests fail to connect. Set it on the command line:

```bash
# local example: Postgres on 5433 with trust auth
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres npm test
```

CI sets `TEST_DATABASE_URL` to its `postgres:16` service container in the job `env` block, so CI
never hits this.

### The headline end-to-end test

`apps/server/src/sync.e2e.test.ts` exercises the *real* Rust crypto end-to-end by shelling out to
the hermetic `cerberus-cli` oracle. It auto-builds the CLI (`cargo build --bin cerberus-cli`) on
first run, or honours the prebuilt path in `CERBERUS_CLI_BIN` (CI sets
`target/debug/cerberus-cli`). This is how a TypeScript test verifies that the TS wire formats and
the Rust crypto actually round-trip, without re-implementing crypto in TS.

### Vitest configuration

[vitest.config.ts](../../vitest.config.ts): default environment is **node** (zod validators,
services against the ephemeral Postgres, the Tauri IPC wrapper). React component tests opt into
**jsdom** per file with a `// @vitest-environment jsdom` docblock. `esbuild.jsx: 'automatic'`
matches the desktop tsconfig's automatic JSX runtime so `.tsx` tests transform without importing
React. The `include` glob is `apps/**/src/**/*.test.{ts,tsx}` plus `packages/**/...`.

### Linting and type-checking gates

- [tsconfig.base.json](../../tsconfig.base.json): `strict` plus `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`,
  `useUnknownInCatchVariables`; `noEmit` (type-check only). Each workspace extends this.
- [eslint.config.mjs](../../eslint.config.mjs): flat config enforcing three project rules —
  `@typescript-eslint/no-explicit-any` (`any` banned), `@typescript-eslint/no-floating-promises`
  (no unhandled async), and a `no-restricted-syntax` rule banning default exports (named exports
  only). Type-aware rules are scoped to `.ts/.tsx` via `projectService`. `apps/desktop/src-tauri`,
  `dist`, `target`, `design/`, and `docs/design/` are ignored; config files are exempt from the
  default-export ban.
- Rust: `cargo fmt --check` and `cargo clippy -D warnings`; the crate inherits the workspace lint
  policy via `[lints] workspace = true`.

---

## 8. Demo tooling — DEV ONLY

Plain English: a set of scripts that conjure a ready-to-demo account and can force a behavioral
step-up on cue, so you can show the adaptive-auth pipeline without spending minutes live-typing a
baseline. **None of it ships or changes production logic** — it only feeds the *unmodified* engine
known inputs and (in dev) lowers a few activation thresholds. Full guide:
[docs/DEMO.md](../DEMO.md).

The scripts (root → server workspace):

| Script | File | What it does |
|---|---|---|
| `npm run demo:seed` | [demo/seed.ts](../../apps/server/src/demo/seed.ts) | Idempotently create a `demo` account (master password `demovault77`) with an already-**ACTIVE** keystroke baseline, a **confirmed TOTP** secret (prints the base32 + `otpauth://` URI), a **known device**, and example credentials stored as opaque AEAD blobs in the server's `vault_items`; clears the local `vault.json` so the next unlock reconstructs from the server (ADR-0008 pull-sync). Prints login instructions. |
| `npm run demo:reset` | `demo/reset.ts` | Remove the demo account and everything it owns, then re-seed to the same deterministic state. |
| `npm run demo:impostor` | `demo/impostor.ts` | Log in as `demo` with a deliberately strongly-anomalous keystroke sample (correct dimension, so it is *scored* not rejected). The unmodified scorer flags ~1.0 anomaly → the policy bands it to a **step-up** — a reliable on-cue behavioral step-up. Posts to `DEMO_API_BASE_URL` / `VITE_API_BASE_URL` / `http://localhost:8080`; needs the dev server running. |
| `npm run demo:geovelocity` | `demo/geovelocity.ts` | Drives the geovelocity (impossible-travel) contextual signal. |

The seed/impostor scripts use the **`cerberus-cli` oracle** for client-side crypto (so they never
re-implement it). Build it once with `npm run build:cli`.

The demo password is engineered: [demo/env.ts:13-23](../../apps/server/src/demo/env.ts) notes
`demovault77` is "deliberately SHIFT-FREE and exactly 11 keystrokes" so the desktop app's captured
sample has `featureDimension(11) = 31`, matching the seeded baseline's dimension and is therefore
*scored* rather than rejected as a dimension mismatch. See [Behavioral engine](06-behavioral-engine.md).

### Why it can't run in production (three independent walls, fail closed)

1. **Script gate.** Every demo script calls `assertDevDemoEnvironment(databaseUrl)` first
   ([demo/env.ts:73-92](../../apps/server/src/demo/env.ts)): it throws if `NODE_ENV ===
   'production'`, and throws on a non-local `DATABASE_URL` (host not `127.0.0.1` / `localhost` /
   `::1`) unless `DEMO_ALLOW_NONLOCAL_DB=yes` is set for a known throwaway dev DB. The scripts are
   invoked only by the `demo:*` npm scripts — never imported by the running server.
2. **Config gate.** The four demo *knobs* are ignored in production (§6); the secure defaults
   apply and the override is logged as ignored.
3. **Binary gate.** The `cerberus-cli` oracle the seed/impostor use is a dev/test binary that is
   never part of the production app.

A typical demo (from [docs/DEMO.md](../DEMO.md)): `demo:seed` (add the printed TOTP to your
authenticator) → `dev:server` + `dev:app`, log in as `demo`/`demovault77` → `demo:impostor`
forces a step-up → complete the TOTP → open the **Risk inspector (Research)** panel, where a
step-up-confirmed session can read its own scored `risk_events`. See
[Continuous auth](08-continuous-auth.md) and [Frontend](11-frontend.md).

---

## 9. Evaluation runners — DEV ONLY, datasets gitignored

Plain English: scripts that reproduce the accuracy numbers in the thesis from research datasets,
so every figure is regenerable rather than hand-typed. They live in the server workspace; run them
with `--workspace @cerberus/server` (they are **not** exposed at the repo root).

| Script | Runner | Dataset (gitignored) | Output |
|---|---|---|---|
| `npm run eval:keystroke` | [run-keystroke-eval.ts](../../apps/server/src/eval/run-keystroke-eval.ts) | CMU keystroke-dynamics CSV | `docs/evaluation/keystroke-detector-comparison.{json,md}` |
| `npm run eval:mouse` | `run-mouse-eval.ts` | Balabit mouse benchmark | `docs/evaluation/` |
| `npm run eval:tune` | `run-threshold-tuning.ts` | behavioral split | threshold-tuning report |
| `npm run eval:integrated` | `run-integrated-analysis.ts` | combined | integrated-study report |

Walking `run-keystroke-eval.ts` ("follow the data"):
1. Resolve the dataset path: `CMU_DATASET_PATH` env, else
   `docs/evaluation/data/DSL-StrongPasswordData.csv`. If it does not exist, print where to fetch
   it and exit non-zero — the dataset is **not committed** (real human captures, a privacy rule).
2. `loadCmuDataset` + `groupCmuBySubject` parse and group by subject (the same M6 feature
   extractor the live engine uses — no second implementation).
3. `runEvaluation(dataBySubject, createDetectors(config), config)` runs the Killourhy & Maxion
   (2009) protocol with all three detectors (Mahalanobis, one-class SVM, isolation forest),
   using `DEFAULT_EVALUATION_CONFIG` with a fixed seed (deterministic → identical numbers each
   run).
4. Write a JSON report and a human Markdown summary into `docs/evaluation/`. The summary table
   includes a `K&M 2009` column citing the published EERs (Mahalanobis ≈ 11.0%, one-class SVM
   ≈ 10.2%) for comparison; isolation forest is a later addition with no figure in that study.

Because the underlying datasets are gitignored, the encyclopedia *quotes* the committed result
files with provenance rather than recomputing them. See
[Algorithms deep-dive](14-algorithms-deep-dive.md) for the EER (Equal Error Rate) method and the
detector internals.

---

## 10. How it connects

- **Hermetic core ⇄ desktop feature.** The `desktop` Cargo feature is the seam between the
  always-buildable crypto/vault core (CI job 1, `cerberus-cli`, the E2E test) and the heavy native
  app (CI job 2, `npm run dev:app`). Everything security-critical is exercised without a GUI.
- **`cerberus-cli` is the bridge between TS tests and Rust crypto.** CI job 3 builds it; the E2E
  test drives it; the demo seed/impostor scripts call it for client crypto. See
  [Cryptographic core](04-cryptographic-core.md).
- **`config.ts` feeds the whole server.** The env vars in §6 become the `ServerConfig` the
  routes/services/repositories consume — risk bands, combiner inputs, continuous-auth thresholds,
  rate limits, CORS, GeoIP. See [Server and API](09-server-and-api.md),
  [Decision and policy](07-decision-and-policy.md), [Continuous auth](08-continuous-auth.md).
- **Migrations ⇄ tests.** The same `migrations/*.sql` the runner applies in dev are concatenated
  and applied by the test harness on every run. See [Database](10-database.md).

---

## 11. Gotchas and invariants

1. **`npm run dev:app` needs both flags — `--features desktop -- --bin cerberus-desktop`.** A bare
   `npm run tauri dev` fails twice: the crate exposes **two** binaries (`cerberus-desktop` the app
   and `cerberus-cli` the auto-discovered oracle), so cargo can't pick one; and it omits the
   `desktop` feature the app needs. The flags fix both, and they are baked into the `tauri:dev`
   script. ([DEV_RUNBOOK.md](../../DEV_RUNBOOK.md), [Cargo.toml](../../apps/desktop/src-tauri/Cargo.toml).)
2. **`vitest` does not read `.env` → set `TEST_DATABASE_URL`** (user-memory gotcha; §7). Tests
   otherwise default to `…@127.0.0.1:5432/postgres` and fail if your Postgres is elsewhere.
3. **Migrate the DB before running new code.** No startup guard for pending migrations; a missing
   column surfaces as a runtime 500 (recon §11.4). Tests are immune (fresh DB each run).
4. **Demo knobs are inert in production.** Gated by `demoOverridesAllowed(nodeEnv)`; ignored and
   logged in production (§6). They can never weaken a shipped binary.
5. **Production refuses insecure defaults** for `ENUMERATION_SECRET` and `BASELINE_ENC_KEY`
   (fail closed; §6). Don't "fix" a startup crash by reusing the dev default — set a real secret.
6. **The `time` crate is pinned `=0.3.47`** behind the `desktop` feature; build CI with
   `--locked` and don't bump it (`time >=0.3.48` breaks `tauri-utils 2.9.2`).
7. **`cerberus-cli` reads the master password from stdin, never argv**, and is a dev/test oracle
   that is never shipped in the production app — see its module doc
   ([cerberus-cli.rs:1-13](../../apps/desktop/src-tauri/src/bin/cerberus-cli.rs)). It auto-builds
   in tests or honours `CERBERUS_CLI_BIN`. (Argv would leak the secret into the process table.)
8. **`tauri dev` dirties `Cargo.toml`.** The Tauri CLI auto-appends `, features = []` to the
   `tauri`/`tauri-build` deps on every run; it's a harmless no-op. Discard it with
   `git checkout -- apps/desktop/src-tauri/Cargo.toml` — do not commit it (it conflicts with the
   ADR-0006 dependency notes). ([DEV_RUNBOOK.md](../../DEV_RUNBOOK.md).)
9. **The README status line now matches the code.** [README.md:10-14](../../README.md) reads
   *"Implemented end-to-end (milestones M1–M12). The zero-knowledge vault, the Rust cryptographic
   core … encrypted multi-device blob sync, behavioral (keystroke) + contextual risk scoring, the
   adaptive login policy with TOTP step-up, and mouse-dynamics continuous authentication are all
   built and tested."* (Recon §11.1 flagged an earlier "Milestone 1 … no crypto, vault, or risk
   logic yet" line as badly stale; the README has since been corrected, so that gap is closed.)
10. **`RL_ACCOUNT_MAX_FAILURES` / `RL_ACCOUNT_LOCKOUT_MS` are vestigial.** Still parsed into
    `RateLimitConfig` but unused — the M4 per-account lockout was replaced by the brute-force
    backstop (`BACKSTOP_*`). Setting them has no effect (recon §11.6).
11. **No single root "run all" command** (no `concurrently` dependency) — server and app run in
    two terminals by design.
