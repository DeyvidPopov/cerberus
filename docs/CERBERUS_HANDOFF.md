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
- **Post-M12 hardening + live inspector (latest session, ADR-0016/0017/0018):**
  - **(1) Geovelocity baseline = last CONFIRMED login** (ADR-0016). The "previous location" now
    comes from the latest *issued session* (grant / bootstrap / passed step-up), not any
    password-correct attempt. A denied or un-passed step-up no longer poisons the baseline, so an
    attacker holding the password can't neutralise the impossible-travel signal with a throwaway
    attempt; a passed step-up still advances it so a genuine traveller settles. Migration **0007**
    adds coarse `geo_country` to `sessions` + `step_up_challenges` (country only; ADR-0002 §5).
  - **(2) Device trust is EARNED** (ADR-0017). A returning device with confirmed logins on **≥5
    distinct UTC days** graduates known-untrusted (0.3) → known-trusted (0), making the
    previously-dead trusted tier reachable. Distinct days (not volume), confirmed logins only, not
    elapsed time. No migration (uses the existing `devices.trusted` column); no trust UI/revocation
    yet (follow-up).
  - **(3) Live keystroke rhythm in the inspector** (ADR-0018). Panel 3 can show the user's REAL
    enrolled baseline vs this sign-in's REAL captured rhythm via a new `GET /risk/keystroke-rhythm`
    (durations only). A **deliberate, scoped, reversible relaxation of ADR-0002** — gated to a
    step-up-confirmed *self* session AND **non-production only** (unmounted = 404 in prod). Falls
    back to an honestly-labelled illustrative overlay otherwise, naming the reason in-panel
    ("type, don't paste" / "no enrolled rhythm yet"). Adversarially reviewed (multi-agent): no
    confirmed defects.
  - **(4) UX:** rhythm enrolment now starts at 0 (purges the passively-buffered login sample on the
    first deliberate capture; skipping still preserves passive learning); the vault enrolment
    banner refreshes after onboarding; inspector chart axes auto-scale to real data; a **dev-only
    `X-Demo-Geo` override** (desktop control + non-production CORS allowance) demonstrates
    geovelocity on localhost.

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
- 0016 geovelocity baseline = last CONFIRMED login (issued session), not any attempt — closes
  denied-attempt baseline poisoning (migration 0007: sessions/step_up_challenges `geo_country`)
- 0017 device trust EARNED by confirmed logins on N distinct days (known-untrusted → trusted)
- 0018 live keystroke rhythm in the gated inspector — SCOPED, non-production relaxation of
  ADR-0002 (self + step-up + durations only; new `GET /risk/keystroke-rhythm`)

## Local dev / ops notes (so a fresh environment works)

- **Postgres runs on port 5433** here (role/db `cerberus`); `.env` has
  `DATABASE_URL=postgres://cerberus:cerberus@127.0.0.1:5433/cerberus`, server + desktop on `:8080`.
  Tests use `TEST_DATABASE_URL` on `:5433` (ephemeral DBs, always fully migrated).
- **Run `npm run migrate` after pulling schema changes.** A stale dev DB missing a migration shows
  up as a **500 on the affected endpoint** (this bit us: the dev DB lacked migration 0005's
  `modality` column → every login 500'd). Forward-only; never edit an applied migration. **Latest:
  0007** (`sessions`/`step_up_challenges` `geo_country`, ADR-0016) — 7 migrations total.
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
- **Device trust (ADR-0017) has no explicit "trust/untrust this device" UI and no revocation** —
  trust is auto-earned + monotonic only. Candidate follow-up if device management becomes a feature.
- **Live-rhythm inspector (ADR-0018) is demo/non-production only** (unmounted in prod). The chart's
  "flight" is the *down-to-down* interval (display choice; always positive); could switch to the
  textbook *up-to-down* "flight time". Optional: **block paste on the login master-password field**
  (like the enrolment screen) so a paste doesn't silently suppress behavioral telemetry + the live
  rhythm (trade-off vs. password-manager users).
- A behavioral baseline can't be exercised live in a demo without **typing** the master password —
  paste/autofill taints the capture (no rhythm), shows "missing sample" + a fail-closed step-up.
