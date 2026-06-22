# Cerberus — Demo Tooling (DEV ONLY)

Quick, repeatable way to demonstrate the adaptive-auth pipeline without live
enrollment. **None of this is shipped or changes production logic.** Every piece is
hard-gated to non-production (`NODE_ENV !== production`), and the scripts refuse a
non-local database. The defaults and the scoring/policy code are untouched — the
demo only feeds the existing, unmodified engine known inputs and lowers a few
activation thresholds in dev.

> Prereq: a local dev Postgres + applied migrations (see `DEV_RUNBOOK.md`), and the
> client-crypto oracle built once:
> `npm run build:cli` (≈ `cargo build --bin cerberus-cli`).

---

## 1. Demo config knobs (dev-gated)

These env vars already exist; for a demo set them in `.env`. They are **honored only
when `NODE_ENV != production`** — a production build ignores them and uses the secure
defaults (and logs that it did). Production defaults are unchanged.

| Env var | Prod default | Demo value | Effect |
|---------|--------------|-----------|--------|
| `MIN_ENROLLMENT_SAMPLES` | `10` | `3` | A keystroke baseline activates after fewer logins. |
| `MOUSE_MIN_ENROLLMENT_SAMPLES` | `12` | `4` | The in-session mouse baseline activates quickly. |
| `CONTINUOUS_AUTH_EWMA_ALPHA` | `0.5` | `0.9` | More reactive in-session composite. |
| `CONTINUOUS_AUTH_SPIKE_THRESHOLD` | `0.85` | `0.35` | A mouse-dynamics spike → vault lock fires within seconds. |

Gating lives in [`apps/server/src/config.ts`](../apps/server/src/config.ts)
(`demoIntFromEnv` / `demoFloatFromEnv`, gated by `demoOverridesAllowed`), proven by
[`apps/server/src/config.test.ts`](../apps/server/src/config.test.ts).

`.env` snippet for a demo:

```
NODE_ENV=development
MIN_ENROLLMENT_SAMPLES=3
MOUSE_MIN_ENROLLMENT_SAMPLES=4
CONTINUOUS_AUTH_EWMA_ALPHA=0.9
CONTINUOUS_AUTH_SPIKE_THRESHOLD=0.35
```

---

## 2. Seed a ready account — `npm run demo:seed`

Creates (idempotently — it replaces any prior demo account) on the **local dev DB**:

- a `demo` account whose master password is **`demovault77`** (11 shift-free keys, so
  the app's captured keystroke sample matches the seeded baseline's dimension);
- an **already-ACTIVE keystroke baseline** (fed through the real enrollment lifecycle,
  so no live enrollment is needed);
- a **confirmed TOTP secret** — the script prints the base32 secret and the
  `otpauth://` URI so you can add it to an authenticator app;
- a **known device** enrolled (so a later login isn't penalised as a new device);
- a few **example credentials** stored as opaque AEAD blobs (the server holds only
  ciphertext — zero-knowledge intact).

It prints copy-pasteable login instructions. Refuses to run if `NODE_ENV=production`
or against a non-local `DATABASE_URL` (override a throwaway remote dev DB only with
`DEMO_ALLOW_NONLOCAL_DB=yes`).

---

## 3. Reset — `npm run demo:reset`

Removes the demo account and everything it owns, then re-seeds to the same known,
reproducible state (the synthetic baseline is deterministic). Same dev gating.

---

## 4. Impostor helper — `npm run demo:impostor`

Logs in as the demo account with a **deliberately strongly-anomalous keystroke
sample** (correct dimension, so it is *scored* rather than rejected) against the real
`/auth/login`. The **unmodified** scorer flags it (~1.0 anomaly) and the adaptive
policy bands it to a **step-up** — a reliable, on-cue behavioral step-up for the demo.

It does **not** change scoring, thresholds, or any policy — it only feeds a known-bad
input. Requires the dev server running (`npm run dev:server`) and the account seeded.
Posts to `DEMO_API_BASE_URL` / `VITE_API_BASE_URL` / `http://localhost:8080`.

A typical demo:

1. `npm run demo:seed` → add the printed TOTP to your authenticator.
2. `npm run dev:server` and `npm run dev:app`; log in as `demo` / `demovault77`.
3. `npm run demo:impostor` → the system demands a step-up; complete the TOTP in the app.
4. Open the **Risk inspector (Research)** panel — a step-up-confirmed session can now
   read its own scored `risk_events`.

> Note: because the seeded baseline is synthetic (not trained on *your* typing), a
> genuine app login may itself be scored as somewhat unfamiliar and ask for the TOTP —
> that's adaptive auth working. The impostor helper is the *reliable* way to force a
> step-up on cue.

---

## 5. Why this can't run in production

- The three scripts call `assertDevDemoEnvironment()`
  ([`apps/server/src/demo/env.ts`](../apps/server/src/demo/env.ts)) first: they throw
  if `NODE_ENV=production`, and throw on a non-local `DATABASE_URL` unless explicitly
  allowed. They are invoked only by the `demo:*` npm scripts (never imported by the
  app), so they never run as part of the server.
- The config knobs are gated in `config.ts`: in production the demo env vars are
  ignored and the defaults apply.
- The client-crypto oracle the seed/impostor use (`cerberus-cli`) is a dev/test
  binary that is never part of the production app (PROJECT.md).
