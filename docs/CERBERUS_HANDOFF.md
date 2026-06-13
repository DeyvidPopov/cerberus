# Project Cerberus — Planning Handoff (resume in a new chat)

Paste this into a new chat to resume planning/review exactly where the previous one ended.
This is the PLANNING state (what's done, decided, next). Durable build rules live in `CLAUDE.md`
+ `PROJECT.md` + the ADRs in the repo; this document points to them rather than repeating them.

---

## What Cerberus is

A zero-knowledge password vault (encrypted credential store) with a risk-based adaptive
authentication layer driven by **keystroke + mouse behavioral analysis + contextual signals**.
Enforced at login (adaptive grant / TOTP step-up / deny) and **continuously in-session** (mouse
dynamics; a risk spike locks the vault). Bachelor thesis (FDIBA). Stack: Tauri + Rust
(desktop/security core), React + TypeScript (UI — shadcn/ui + Tailwind), Node.js + Express
(server), PostgreSQL, WebSocket (continuous auth).

## Working method

- I (planning chat) act as architect/reviewer; Claude Code does the implementation.
- One milestone per Claude Code prompt. Each prompt ends with a fixed REPORT block.
- The human pastes the report back here; I verify it against PROJECT.md + ADRs, then issue the
  next milestone prompt (or corrections). Milestone prompts are written as docs/claude-code-\*.md.
- Git: trunk-based per `GIT_WORKFLOW.md` — short-lived `feat/…` branch → ff-only merge into `main`
  → push → CI green. `main` is the trunk and currently contains everything below.

## Status — ALL milestones M1–M12 COMPLETE; CI-green; `main` is the superset

**Phase 1 (vault + zero-knowledge), done earlier:**
- **M1** scaffold + hermetic CI · **M2** Rust crypto core (ADR-0001: Argon2id 224 MiB/t=3/p=1
  ~521 ms, HKDF-SHA-256, XChaCha20-Poly1305; KAT vectors; tamper→fail, wrong-key→Err) ·
  **M3** Tauri wiring + local vault CRUD (behind the `desktop` feature) · **M4** zero-knowledge
  login + device enrollment (prelogin/derive/verify; enumeration mitigation; constant-time) ·
  **M5** encrypted blob sync (opaque-blob CRUD, revision 409, no-IDOR, fresh-client E2E).

**Phases 4–8 (the adaptive-auth engine — the thesis contribution):**
- **M6** keystroke capture + enrollment lifecycle (ADR-0009) — position-indexed, model-only
  baseline, Ledoit-Wolf + ridge covariance, raw purged on activation.
- **M7** Mahalanobis → χ² scoring + offline detector comparison (ADR-0010) — first FAR/FRR/EER.
- **M8** contextual signals (ADR-0011) — new-device, geovelocity, time-of-day, failure-velocity.
- **M9** adaptive policy + TOTP step-up enforcement (ADR-0012) — combiner → bands → grant/step-up/
  deny; replaced the M4 per-account lockout with the adaptive + per-IP-backstop model.
- **M10** continuous auth — mouse dynamics over a session-authenticated WebSocket (ADR-0013);
  modality-agnostic reuse of the scorer + enrollment lifecycle; spike → lock (fail closed);
  cold-start neutral. Also: distinct login-outcome messages + TOTP enrollment nudge.
- **M11** evaluation harness + reproducible results (ADR-0014) — Balabit mouse benchmark, the
  band-threshold tuning (held-out, no tune-on-test), integrated-study tooling, consolidated docs.
- **M12** UI/UX patch — the "Vault" design system (ADR-0015): shadcn/ui + Tailwind tokens; every
  screen restyled (register/unlock/outcomes/vault/step-up/TOTP/enrollment/spike-lock); behavior
  unchanged; keystroke capture intact; no-risk-detail copy preserved.
- **Post-M12 fixes:** (1) Argon2id derivation moved OFF the webview main thread (Tauri commands
  → `async` + `spawn_blocking`) so register/login no longer freeze the UI; (2) registration shows
  distinct messages (409 username-taken etc.) instead of the raw "request failed"; (3) a 5xx
  server fault now maps to a distinct "server problem" message instead of the generic fallback.

### Headline evaluation numbers (reproducible — `npm run eval:*`, docs/evaluation/)

| modality | dataset | detector (deployed) | EER (mean ± SD) |
|----------|---------|---------------------|-----------------|
| keystroke (login) | CMU | Mahalanobis | **13.42% ± 6.73%** (SVM 10.69%, iForest 8.89%) |
| mouse (continuous) | Balabit | Mahalanobis | **38.18% ± 7.82%** (SVM 35.94%, iForest 34.95%) |

Tuned login operating point: `stepUp 0.30 / deny 0.70` (chosen ≈0.29 at a 7% genuine
false-step-up budget; behavioral validation EER 19.25%). Mouse is honestly noisier than keystroke
— which is exactly why behavioral scores are soft, contributing signals closed by context + TOTP,
and continuous auth smooths windows (EWMA) before locking.

## ADRs in the repo (docs/adr/) — these feed the thesis directly

- 0001 crypto model · 0002 behavioral baselines & scoring · 0003 hermetic CI / desktop feature
- 0004 tooling baseline · 0005 crypto wire format & domain separation · 0006 desktop architecture
- 0007 zero-knowledge login handshake · 0008 encrypted blob sync
- 0009 behavioral feature schema, position-indexed capture & enrollment lifecycle
- 0010 Mahalanobis→χ² scoring & offline detector comparison (Killourhy & Maxion)
- 0011 contextual risk signals (new-device, geovelocity, time-of-day, failure-velocity)
- 0012 adaptive policy + enforcement + TOTP step-up (combiner, bands, brute-force model)
- 0013 continuous auth: mouse dynamics, windowed WS streaming, spike→lock (modality reuse)
- 0014 evaluation methodology: Balabit mouse benchmark, operating-point tuning, integrated study
- 0015 UI design system ("Vault"): shadcn/ui + Tailwind tokens, no-risk-detail copy rule

## Local dev / ops notes (so a fresh environment works)

- **Postgres runs on port 5433** here (role/db `cerberus`); `.env` has
  `DATABASE_URL=postgres://cerberus:cerberus@127.0.0.1:5433/cerberus`, server + desktop on `:8080`.
  Tests use `TEST_DATABASE_URL` on `:5433` (ephemeral DBs, always fully migrated).
- **Run `npm run migrate` after pulling schema changes.** A stale dev DB missing a migration shows
  up as a **500 on the affected endpoint** (this bit us: the dev DB lacked migration 0005's
  `modality` column → every login 500'd). Forward-only; never edit an applied migration.
- **Evaluation datasets are fetched + gitignored** under `docs/evaluation/data/` (CMU keystroke;
  Balabit mouse — `git clone` the challenge repo). Scripts: `eval:keystroke`, `eval:mouse`,
  `eval:tune`, `eval:integrated` (in `@cerberus/server`). Derived results ARE committed.
- **`design/` is the M12 UI reference mockup** (gitignored, never imported/shipped).
- Gates before merge: `cargo fmt --check` · `cargo clippy -D warnings` · `cargo test` (hermetic +
  `--features desktop`) · `tsc --noEmit` · `eslint` · `vitest` (+ ephemeral Postgres). All green.
- `tauri dev` builds the Rust core in DEBUG → Argon2id takes several seconds (≈0.5 s in release).
  The UI stays responsive (derivation is off-thread now); for production-like timing use a release
  build.

## NEXT / open follow-ups (non-blocking)

- **Thesis writeup**: Phase-1 chapter drafted (Cerberus_Phase1.docx). Phases 4–8 (behavioral +
  contextual + adaptive policy + continuous auth + evaluation) and the M12 UI are now ready to
  write up; the ADRs (0009–0015) + `docs/evaluation/` numbers are the raw material.
- **Optional integrated study (Part C, M11)**: tooling is built + unit-tested; run labeled
  end-to-end sessions to get composite FAR/FRR + step-up / false-step-up / false-lock rates. The
  contextual signals are only evaluable this way (stated limitation — no public benchmark).
- **`unlock` Tauri command is still synchronous** (it re-derives the vault key under the vault
  Mutex; not on the login path). If the local-vault unlock path becomes user-facing, convert it to
  `async` + `spawn_blocking` like the other derivation commands (State + lock needs care).
- **Pending-migration startup guard** (recommended): have the server log/refuse on startup if
  `schema_migrations` is missing any migration file — the only thing that would have caught the
  stale-dev-DB login 500 (ephemeral-DB tests can't, by design).
- **M12 mockup features intentionally NOT built** (would be new behavior): clipboard "copy" on
  credentials, a QR image on TOTP setup (setup key + URI shown instead), vault search/categories.
- npm audit advisories are dev-only build tooling (vite/vitest/jsdom), deferred — documented.
- Conflict handling is blob-level (revision 409), not field-level merge — future work (ADR-0008).
