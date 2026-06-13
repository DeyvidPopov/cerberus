# Cerberus — Local Dev Runbook

Bring up Postgres + the Express API + the desktop webview for hands-on local use.
Copy-pasteable. Windows / PowerShell. Secrets live in a gitignored `.env` (never commit it).

> This machine's setup: **Node 24**, **PostgreSQL 18 on port 5433** (trust auth, no Docker),
> **Rust 1.96 (stable-msvc)** + **VS Build Tools 2026** + **WebView2 149** — full Tauri toolchain
> present, so the native desktop window builds and runs (verified).

---

## Prerequisites

| Tool | Needed for | This machine | Install (Windows) |
|------|-----------|--------------|-------------------|
| Node ≥ 20.11 | server, migrations, webview | ✅ v24 | `winget install OpenJS.NodeJS.LTS` |
| PostgreSQL ≥ 14 | database | ✅ v18 on **5433** | `winget install PostgreSQL.PostgreSQL.18` |
| Rust (stable-msvc) | native Tauri window | ✅ 1.96 | `winget install Rustlang.Rustup` → `rustup default stable-msvc` |
| MSVC C++ Build Tools | linking the Rust core | ✅ VS BT 2026 | `winget install Microsoft.VisualStudio.2022.BuildTools` (+ "Desktop development with C++") |
| WebView2 Runtime | Tauri webview host | ✅ 149 | `winget install Microsoft.EdgeWebView2Runtime` |

Verify the toolchain anytime with `npm run tauri info --workspace @cerberus/desktop`.

`psql` on this machine: `C:\Program Files\PostgreSQL\18\bin\psql.exe` (PATH alias: `psql`).
`cargo`/`rustc` live in `%USERPROFILE%\.cargo\bin` — on PATH in a normal terminal (rustup adds it).

---

## First-time setup

```powershell
# 1. Install JS deps (workspaces) — from the repo root
npm install

# 2. Create the dev role + database (Postgres listens on 5433 with trust auth here).
#    Safe to re-run; ignore "already exists".
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
& $psql -U postgres -h 127.0.0.1 -p 5433 -c "CREATE ROLE cerberus LOGIN PASSWORD 'cerberus';"
& $psql -U postgres -h 127.0.0.1 -p 5433 -c "CREATE DATABASE cerberus OWNER cerberus;"

# 3. The local .env already exists (gitignored). If missing, copy the example and edit:
#    - DATABASE_URL -> postgres://cerberus:cerberus@127.0.0.1:5433/cerberus
#    - generate real secrets:
#        node -e "console.log('ENUMERATION_SECRET='+require('crypto').randomBytes(32).toString('base64url'))"
#        node -e "console.log('BASELINE_ENC_KEY='+require('crypto').randomBytes(32).toString('hex'))"
copy .env.example .env   # only if you don't already have a .env

# 4. Apply migrations (forward-only, through 0004)
npm run migrate
```

The `.env` loads automatically: the `dev`/`start`/`migrate` scripts pass Node's
`--env-file-if-exists` flag (no `dotenv` dependency; the flag is a no-op in CI where the
environment is supplied directly).

---

## Run it (two terminals)

There's no single root command (no `concurrently` dependency), so use two terminals.

**Terminal 1 — API server** (http://localhost:8080):
```powershell
npm run dev:server
```
Health check: `curl http://localhost:8080/health` → `{"status":"ok",...}` (200).

**Terminal 2 — native desktop app** (recommended — the real app):
```powershell
npm run dev:app          # == tauri dev --features desktop -- --bin cerberus-desktop
```
Tauri starts Vite (pinned to port 1420 to match `tauri.conf.json` `devUrl`), compiles the Rust core
(first build ~1–2 min), and opens the native Cerberus window. Full crypto/register/login works here
because key derivation happens in the Rust core. Stop with `Ctrl+C` in this terminal.

> **The bin-selection flags are required** (and are baked into `dev:app` / the desktop `tauri:dev`
> script). `src-tauri` exposes **two** binaries — the app (`cerberus-desktop`) and the dev/test
> oracle (`cerberus-cli`, an auto-discovered `src/bin/` target). A bare `npm run tauri dev` therefore
> fails with *"`cargo run` could not determine which binary to run"* AND omits the `desktop` feature
> the app bin requires. `--features desktop -- --bin cerberus-desktop` fixes both. This is the
> "Windows bin-harness quirk" the project notes — the app runs fine via `tauri dev` with these flags.

**Webview-only (optional, no Rust):** `npm run dev:desktop` runs just the Vite webview at
http://localhost:1420. The register/login screen renders and points at `VITE_API_BASE_URL`
(defaults to `http://localhost:8080`, from `.env`), but the browser webview can't derive keys —
use `dev:app` for the full flow.

---

## Verify the desktop IPC commands (register → enroll → login → step-up)

The webview→Rust commands are invoked over Tauri IPC. **Tauri v2 maps camelCase
`invoke` keys to the Rust commands' snake_case parameters** (`masterPassword` →
`master_password`); `apps/desktop/src/lib/tauri.ts` sends camelCase accordingly
(`apps/desktop/src/lib/tauri.test.ts` pins the exact wire keys for every command).
Run `npm run dev:app` and walk the flow below — each step exercises the listed
command(s) end to end. (Step-up + TOTP are **HTTP** calls via `lib/api.ts`, not Tauri
IPC, so they have no camelCase mapping to verify.)

| Action in the app | IPC command(s) exercised | Expected |
|-------------------|--------------------------|----------|
| **Register** a new account | `prepare_registration` | Account created; you land in the vault (this was the failing command). |
| **Lock** the vault | `lock` | Returns to the unlock screen. |
| **Log in** (unlock) | `derive_login_auth_key_cmd` → server; then `unlock` opens the local vault | Granted (or a step-up prompt). |
| **Add** a credential | `add_credential` | Appears in the list. |
| **List** / open the vault | `list_credentials` | Summaries render. |
| **Reveal** / start editing one | `get_credential` | Full credential (incl. password) shown. |
| **Save** an edit | `update_credential` | Updated values persist. |
| **Delete** one | `delete_credential` | Removed from the list. |
| **Sync push / pull** a credential | `seal_credential` / `open_credential` | Encrypt/decrypt round-trips against the server blob. |

End-to-end behavioral + enforcement flow (M6–M9):

1. **Register** → granted (bootstrap: new device, no TOTP yet).
2. **Enroll the baseline:** lock + log in repeatedly, typing the master password each
   time. With `MIN_ENROLLMENT_SAMPLES=5` (dev `.env`) the baseline activates after 5
   logins. Each login sends the position-indexed keystroke sample with the request.
3. **Login (active):** typing normally on the known device → granted; the login is
   behaviorally scored (check the server logs / `risk_events`).
4. **Step-up:** set up TOTP, then log in from a "new device" (clear the stored device
   fingerprint, or use a fresh profile) → the server returns `step_up_required`; enter
   the 6-digit code → granted. Suppressing the keystroke sample on an active account
   without TOTP is correctly **denied** (fail closed; ADR-0012).

A failure on any IPC step that reads *"missing required key &lt;camelCaseName&gt;"* is the
casing regression — re-check that `lib/tauri.ts` sends camelCase keys.

---

## Reset the database

Drops and recreates the schema, then re-migrates:
```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
& $psql -U postgres -h 127.0.0.1 -p 5433 -c "DROP DATABASE IF EXISTS cerberus;"
& $psql -U postgres -h 127.0.0.1 -p 5433 -c "CREATE DATABASE cerberus OWNER cerberus;"
npm run migrate
```

## Stop everything

`Ctrl+C` in each terminal. Postgres runs as a Windows service (`postgresql-x64-18`) and keeps
running; stop it only if you want to: `Stop-Service postgresql-x64-18` (restart: `Start-Service ...`).

---

## Notes & dev conveniences

- **`MIN_ENROLLMENT_SAMPLES=5`** in the local `.env` is a **DEV CONVENIENCE** — a behavioral
  baseline activates after 5 logins instead of the real default of **10**, for a faster demo.
- **GeoIP is optional.** Without `apps/server/data/GeoLite2-City.mmdb` the geovelocity signal stays
  neutral (fine locally). To exercise it, fetch the DB per `docs/geoip.md`.
- **Port 5433, not 5432.** This machine's Postgres cluster listens on 5433; `DATABASE_URL` reflects
  that. On a default 5432 install, change the port in `.env`.
- **Tests** use a real ephemeral Postgres via `TEST_DATABASE_URL`
  (`postgres://postgres@127.0.0.1:5433/postgres`, trust auth). Run with `npm test`.
- **Never commit `.env`** (gitignored). Only `.env.example` is tracked.
- **`tauri dev` dirties `Cargo.toml`:** the Tauri CLI auto-appends `, features = []` to the `tauri`
  and `tauri-build` deps on every run. It's a harmless no-op — `git checkout -- apps/desktop/src-tauri/Cargo.toml`
  to discard it (don't commit it; it conflicts with the ADR-0006 dependency notes).
