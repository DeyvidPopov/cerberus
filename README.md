# Cerberus

> _Cerberus — the three-headed guardian of the threshold. Nothing passes unrecognized._

A zero-knowledge password vault with an adaptive, risk-based authentication layer
(behavioral + contextual signals). This repository is a monorepo; the canonical
description of _how_ the project is built lives in **[PROJECT.md](PROJECT.md)** and
is binding. Architectural decisions are recorded in [docs/adr/](docs/adr/).

**Status:** Milestone 1 — monorepo scaffold + CI. Structure and tooling only; no
crypto, vault, or risk logic yet (those land in later phases — see
[ROADMAP.md](ROADMAP.md)).

---

## Repository layout

```
apps/
  desktop/         Tauri app — React + TS webview (src/) + Rust security core (src-tauri/)
  server/          Express API — routes → services → repositories (strict layering)
packages/
  shared-types/    The API contract (TS types), imported by client and server
  protocol/        Documented crypto constants + wire formats (no logic)
migrations/        Ordered, forward-only SQL migrations + runner
docs/              ADRs, threat model, evaluation
```

See [PROJECT.md §2](PROJECT.md) for the authoritative structure.

---

## Prerequisites

- **Node.js ≥ 20.11** and npm (workspaces).
- **Rust** (stable, edition 2021) with `clippy` and `rustfmt` — install via
  [rustup](https://rustup.rs). On Windows the MSVC build tools (C++ workload) are
  required for linking.
- **PostgreSQL** (only needed to actually run migrations / the server against a DB).

---

## Install dependencies

```bash
# JS/TS workspaces (root installs every workspace):
npm install

# Rust crates are fetched on first build:
cargo fetch
```

Copy the environment template and fill in local values (never commit `.env`):

```bash
cp .env.example .env
```

---

## Run the desktop app

The desktop app is a Tauri 2 application (Rust core + React/TS webview). The full
app (webview + Rust runtime) runs with:

```bash
cd apps/desktop
npm run tauri dev          # or: npm run tauri build
```

**Prerequisites:** the Tauri runtime is gated behind the Rust `desktop` feature
and only compiled for the app (not the hermetic core tests). On Linux you need the
webview system libraries (see the `desktop` job in
[.github/workflows/ci.yml](.github/workflows/ci.yml)); on Windows you need WebView2
(preinstalled on Win 11) and the MSVC C++ build tools.

To run just the webview against Vite (no Rust):

```bash
npm run dev:desktop
```

The app opens on a **register / log in** screen (registration requires a password
confirmation). Registration derives the keys in Rust and sends only the auth key,
public KDF params, and the opaque wrapped vault key to the server (zero-knowledge,
ADR-0001/ADR-0007); the master password and encryption key never leave Rust. Keys
live only in Rust memory and are zeroized on lock. The server must be running (see
"Run the server") for register/login to work.

## Run the server

```bash
npm run dev:server      # watch mode (tsx)
# then:
curl http://localhost:8080/health
# -> {"status":"ok","uptimeSeconds":...,"timestamp":"..."}
```

The server reads `PORT`, `NODE_ENV`, `LOG_LEVEL`, and `DATABASE_URL` from the
environment (see [.env.example](.env.example)). The `/health` route touches no
database.

## Run migrations

Applies pending SQL migrations in order against `DATABASE_URL`, idempotently:

```bash
# Ensure DATABASE_URL is set (e.g. via .env), then:
npm run migrate
```

---

## Run CI locally

CI has three jobs (see [.github/workflows/ci.yml](.github/workflows/ci.yml)). Run the
same checks locally before pushing:

```bash
# Rust core (hermetic — no Tauri)
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Tauri desktop build (needs system webview libs + the frontend dist)
npm run build --workspace @cerberus/desktop
cargo build -p cerberus-desktop --features desktop

# TypeScript (all packages)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # vitest — needs a real Postgres (see below)
```

The server repository/integration tests run against a **real ephemeral Postgres**
(PROJECT.md §6): the harness creates a throwaway database per run, applies the
migrations, and drops it. Point it at a server via `TEST_DATABASE_URL` (CI uses a
Postgres service container):

```bash
# Example: a local PostgreSQL on port 5433 with trust auth
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres npm test
```

A red pipeline blocks merge (PROJECT.md §6).

---

## Conventions

Read **[PROJECT.md §4](PROJECT.md)** before writing code. In short:

- **Rust:** edition 2021; no `unwrap`/`expect`/`panic!` in non-test code; one
  `thiserror` enum; typed, zeroizing secrets; `clippy -D warnings`.
- **TypeScript:** `strict` + `noUncheckedIndexedAccess`; `any` banned; named
  exports only; no floating promises; validate every external boundary with zod.
- **Server:** strict layering `routes → services → repositories → db`; all SQL
  parameterized; DB access only in repositories.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `sec:`, …).
