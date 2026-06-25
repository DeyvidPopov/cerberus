# 10 — Database: schema, every table and column, the ER diagram

> Part of the Cerberus encyclopedia. See also: [Architecture](02-architecture.md) ·
> [Repository map](03-repository-map.md) · [Cryptographic core](04-cryptographic-core.md) ·
> [Vault & sync](05-vault-and-sync.md) · [Behavioral engine](06-behavioral-engine.md) ·
> [Decision & policy](07-decision-and-policy.md) · [Continuous auth](08-continuous-auth.md) ·
> [Server & API](09-server-and-api.md) · [Glossary](13-glossary.md).

---

## 1. In plain English

Cerberus keeps everything it must remember on the server in **one PostgreSQL database**. The whole
point of the project is **zero-knowledge**: the server is a locked filing cabinet that stores
sealed envelopes it can never open. So almost every "secret" column in this database is
**ciphertext** (data already encrypted by the user's desktop app) or a **hash** (a one-way
fingerprint). The only things stored in the clear are *non-secret metadata*: your username, the
public settings the app needs to re-derive its keys, item revision numbers, risk scores, a coarse
country code, and a deliberately blurred (truncated) IP address.

A few terms up front, each defined once and again in the [glossary](13-glossary.md):

- **Ciphertext** — data that has been encrypted; unreadable without the key (which the server
  never has).
- **Hash** — a one-way fingerprint. You can check "does this input match?" but cannot run it
  backwards to recover the input. Used here for the auth key and for session/challenge tokens.
- **AEAD (Authenticated Encryption with Associated Data)** — the encryption scheme the desktop uses;
  it both hides data and detects tampering. Each AEAD ciphertext needs a one-time random **nonce**
  ("number used once"), stored alongside it.
- **KDF (Key Derivation Function)** — the slow math (Argon2id) that turns your master password into
  keys. Its public *parameters* and *salt* live in the DB so the app can repeat the derivation; the
  password and the keys never do.
- **Migration** — a numbered `.sql` script that evolves the schema forward. Cerberus only ever adds
  migrations, never edits an old one.

This doc walks every table and every column, says which are server-opaque (ciphertext/hash) vs.
plaintext metadata, explains the foreign-key delete policies (and why two telemetry tables keep
their rows when a user is deleted), shows how each repository scopes its SQL to one `user_id` to
prevent one user reading another's data, and reconciles the schema against
[`docs/schema-reference.md`](../schema-reference.md).

---

## 2. Where it lives

```
migrations/
├── 0001_initial_schema.sql                     all 10 base tables + pgcrypto
├── 0002_enrollment_feature_schema_version.sql  + enrollment_samples.feature_schema_version
├── 0003_contextual_signals.sql                 + login_failures; risk_events cols nullable; sessions.is_new_device
├── 0004_step_up_auth.sql                        + totp_secrets.last_used_step; step_up_challenges token/device/new-device
├── 0005_mouse_modality.sql                      + modality discriminator on the two behavioral tables; re-keyed uniqueness
├── 0006_step_up_confirmed_session.sql           + sessions.step_up_confirmed
└── migrate.ts                                   forward-only runner; creates schema_migrations

apps/server/src/repositories/                    the ONLY layer that speaks SQL
├── pool.ts                  connection pool + withTransaction helper; the Db type
├── users.ts                 users (identity + KDF params)
├── vault-keys.ts            vault_keys (wrapped vault key)
├── vault-items.ts           vault_items (encrypted credentials) — optimistic concurrency
├── devices.ts               devices (new-vs-known signal)
├── behavioral-baselines.ts  behavioral_baselines (fitted, encrypted model)
├── enrollment-samples.ts    enrollment_samples (ephemeral feature buffer)
├── risk-events.ts           risk_events (the evaluation dataset)
├── sessions.ts              sessions (+ continuous-auth lock state)
├── login-failures.ts        login_failures (failure-velocity signal)
├── totp-secrets.ts          totp_secrets (encrypted TOTP secret + replay watermark)
└── step-up-challenges.ts    step_up_challenges (short-lived second-factor handle)

docs/schema-reference.md      a generated consolidated schema reference (covers 0001–0005; see §7)
```

There is no ORM. Every query is hand-written, parameterized SQL inside a repository factory.

---

## 3. File-by-file

### 3.1 The migrations

Each migration is **forward-only** and **never edited after it runs anywhere** (every file says so
in its header). PostgreSQL has no native "schema version"; the runner ([§5](#5-how-it-works-the-migration-runner-then-the-schema))
records applied filenames in `schema_migrations`.

- **[`0001_initial_schema.sql`](../../migrations/0001_initial_schema.sql)** — the foundation. Enables
  the `pgcrypto` extension (for `gen_random_uuid()`), then creates all **10** base tables: `users`,
  `vault_keys`, `vault_items`, `devices`, `behavioral_baselines`, `enrollment_samples`,
  `risk_events`, `sessions`, `totp_secrets`, `step_up_challenges`. Gotcha: in 0001,
  `risk_events.composite_score` / `policy_band` / `action_taken` are **`NOT NULL`** — 0003 relaxes
  that.
- **[`0002_enrollment_feature_schema_version.sql`](../../migrations/0002_enrollment_feature_schema_version.sql)**
  — one `ALTER`: `enrollment_samples` gains `feature_schema_version INTEGER NOT NULL DEFAULT 1`, so a
  fitted baseline never mixes vectors captured under incompatible extractor definitions. The default
  hand-mirrors the TypeScript `FEATURE_SCHEMA_VERSION` constant (SQL can't import TS — kept in sync by
  hand, ADR-0009).
- **[`0003_contextual_signals.sql`](../../migrations/0003_contextual_signals.sql)** — three changes:
  (1) drops `NOT NULL` from `risk_events.composite_score`, `.policy_band`, `.action_taken` so a
  logging-only row can leave them unset; (2) adds `sessions.is_new_device BOOLEAN NOT NULL DEFAULT
  FALSE`; (3) creates the `login_failures` table + two indexes for the failure-velocity signal.
- **[`0004_step_up_auth.sql`](../../migrations/0004_step_up_auth.sql)** — TOTP step-up plumbing:
  `totp_secrets.last_used_step BIGINT` (replay watermark); `step_up_challenges` gains `token_hash`,
  `device_id` (FK → devices, SET NULL), `is_new_device`, plus `idx_stepup_token`.
- **[`0005_mouse_modality.sql`](../../migrations/0005_mouse_modality.sql)** — makes the behavioral
  tables hold **two modalities** (keystroke + mouse). Adds a `modality` column (CHECK
  `('keystroke','mouse')`, default `'keystroke'`) to `behavioral_baselines` and `enrollment_samples`;
  **drops** the 0001 unique key `(user_id, model_version)` and **replaces** it with
  `(user_id, modality, model_version)`; **drops** the 0001 partial index and replaces it with one
  keyed on `(user_id, modality)`; adds `idx_enrollment_user_modality`.
- **[`0006_step_up_confirmed_session.sql`](../../migrations/0006_step_up_confirmed_session.sql)** —
  one `ALTER`: `sessions.step_up_confirmed BOOLEAN NOT NULL DEFAULT FALSE`. This gates the read-only
  risk-inspector endpoint (`GET /risk/events`) so it only serves a session that passed a TOTP
  step-up. Default `FALSE` means the gate **fails closed** for existing/direct-grant sessions.

### 3.2 [`migrate.ts`](../../migrations/migrate.ts) — the runner

One-sentence job: apply pending `*.sql` files, in filename order, each in its own transaction,
idempotently. Key points: reads `DATABASE_URL` (throws if missing), `CREATE TABLE IF NOT EXISTS
schema_migrations`, computes `pending = (all .sql files, sorted) − (already-applied filenames)`, then
for each pending file: `BEGIN` → run the whole SQL file → `INSERT` its filename into
`schema_migrations` → `COMMIT` (any error → `ROLLBACK` + rethrow). The only runtime value
(the filename) is passed as a **bound parameter** — the DDL itself runs verbatim.

### 3.3 [`pool.ts`](../../apps/server/src/repositories/pool.ts) — DB access infrastructure

Exports `createPool(connectionString)` (a `pg.Pool`), the `Db` type (`Pool | PoolClient` — "anything
that can run a parameterized query"), and `withTransaction(pool, fn)` which runs `fn` between
`BEGIN`/`COMMIT`, rolling back on any throw and always releasing the client. Every repository factory
takes a `Db`, so the same code works inside or outside a transaction.

### 3.4 The repositories (one paragraph each)

Each is a `createXRepository(db: Db)` factory returning an object of async query methods, plus an
exported `XRepository` type (`ReturnType<typeof ...>`). They are the **only** place SQL exists
(routes never touch the DB). The recurring security pattern: **every** read and write that touches
user data carries `WHERE user_id = $n` (or is keyed by a token hash that is itself bound to a user) —
this is the IDOR (Insecure Direct Object Reference) defence, enforced in the repository, not just the
route. The DB row shape is snake_case; each repo maps it to a camelCase domain record so storage
shape never leaks upward.

- **[`users.ts`](../../apps/server/src/repositories/users.ts)** — `create`, `findByUsername`,
  `findById`, `existsByUsername`. Maps `kdf_params` JSONB (`{memory_kib, iterations, parallelism}`)
  to `{memoryKib, iterations, parallelism}`. Note: `auth_key_hash` is the **server-side Argon2id hash
  of the client-derived auth key** — not the master password.
- **[`vault-keys.ts`](../../apps/server/src/repositories/vault-keys.ts)** — `create`,
  `findByUserId`. Stores the `wrapped_vault_key` + `nonce`; the server can never unwrap it.
- **[`vault-items.ts`](../../apps/server/src/repositories/vault-items.ts)** — `create`, `listByUser`,
  `getForUser`, `update`, `deleteForUser`. The `update` does **optimistic concurrency**: it bumps
  `revision` only when the stored revision equals `expectedRevision`; on no-match it distinguishes a
  `conflict` (row exists & owned) from `not_found` (absent or owned by someone else). `int8`
  (`revision`) comes back from node-pg as a **string** and is cast with `Number(...)`.
- **[`devices.ts`](../../apps/server/src/repositories/devices.ts)** — `enroll` (upsert: insert new or
  bump `last_seen`; `RETURNING (xmax = 0) AS is_new` tells insert from update — the new-device groundwork)
  and `findForUser` (scoped read). See [§6](#6-gotchas--invariants) for the `xmax` trick.
- **[`behavioral-baselines.ts`](../../apps/server/src/repositories/behavioral-baselines.ts)** —
  `findActiveByUser` (metadata only — **no** model blob), `findActiveModel` (the encrypted blob, for
  scoring/tests), `activate` (upsert to `status='active'`). Exports the `Modality` type
  (`'keystroke' | 'mouse'`), defaulting to `'keystroke'`. The encrypted blob is biometric-adjacent, so
  the routine status path deliberately does **not** return it.
- **[`enrollment-samples.ts`](../../apps/server/src/repositories/enrollment-samples.ts)** — `create`,
  `countByUser`, `pendingDimension`, `listVectorsByUser`, `deleteByUser` (the purge). `feature_vector`
  is JSONB; `pendingDimension` uses `jsonb_array_length(...)` to reject a sample whose dimension
  changed mid-enrollment.
- **[`risk-events.ts`](../../apps/server/src/repositories/risk-events.ts)** — `insert`,
  `findPreviousLocation` (last resolved country+time for geovelocity), `listByUser`,
  `listByUserPaged` (the inspector page; `ORDER BY occurred_at DESC, id DESC` so pages don't overlap).
  `NUMERIC` columns come back as strings → `Number(...)`.
- **[`sessions.ts`](../../apps/server/src/repositories/sessions.ts)** — `create`, `markLocked`
  (continuous-auth spike → status `'locked'`; idempotent), `markStepUpConfirmed`,
  `findActiveByTokenHash` (filters `status='active' AND expires_at > now()`), `recentLoginHours`
  (UTC hours of prior logins, for the time-of-day signal).
- **[`login-failures.ts`](../../apps/server/src/repositories/login-failures.ts)** — `record`,
  `countRecentByUser`, `countRecentByIp`. Append-only; stores only an optional `user_id` and a
  **truncated** IP — never the attempted password or the full IP.
- **[`totp-secrets.ts`](../../apps/server/src/repositories/totp-secrets.ts)** — `upsert` (stores the
  encrypted secret as **unconfirmed**, resets replay state), `findByUserId`, `hasConfirmed`,
  `markConfirmed`, `setLastUsedStep` (the **atomic** monotonic replay watermark; see
  [§6](#6-gotchas--invariants)).
- **[`step-up-challenges.ts`](../../apps/server/src/repositories/step-up-challenges.ts)** — `create`,
  `findPendingByTokenHash` (filters `status='pending' AND expires_at > now()`), `consume` (atomic
  single-use: `UPDATE ... WHERE status='pending'`, returns whether *this* call won).

> Skipped on purpose: `repositories/index.ts` is a stale empty `export {}` stub (the real wiring is
> in `app.ts`) — noted in [the recon notes](00-RECON-NOTES.md) §5d; nothing to document there.

---

## 4. The full schema — the ER diagram

`users` is the root; almost everything hangs off it. The diagram shows every table, its columns, and
its relationships. PK = primary key, FK = foreign key, UK = unique key.

```mermaid
erDiagram
    users ||--|| vault_keys : "has (CASCADE)"
    users ||--o{ vault_items : "owns (CASCADE)"
    users ||--o{ devices : "owns (CASCADE)"
    users ||--o{ behavioral_baselines : "has (CASCADE)"
    users ||--o{ enrollment_samples : "buffers (CASCADE)"
    users ||--o{ sessions : "has (CASCADE)"
    users ||--|| totp_secrets : "has (CASCADE)"
    users ||--o{ step_up_challenges : "has (CASCADE)"
    users |o--o{ risk_events : "logged for (SET NULL)"
    users |o--o{ login_failures : "logged for (SET NULL)"
    devices |o--o{ risk_events : "logged for (SET NULL)"
    devices |o--o{ sessions : "linked (SET NULL)"
    devices |o--o{ step_up_challenges : "linked (SET NULL)"
    sessions |o--o{ step_up_challenges : "linked (CASCADE)"

    users {
        UUID id PK
        TEXT username UK "NOT NULL"
        TEXT auth_key_hash "NOT NULL — Argon2id hash of derived auth key"
        INTEGER kdf_version "NOT NULL"
        BYTEA kdf_salt "NOT NULL"
        JSONB kdf_params "NOT NULL — memory_kib,iterations,parallelism"
        TIMESTAMPTZ created_at "NOT NULL DEFAULT now()"
    }
    vault_keys {
        UUID user_id PK_FK "→users CASCADE"
        BYTEA wrapped_vault_key "NOT NULL — server cannot unwrap"
        BYTEA nonce "NOT NULL"
        TIMESTAMPTZ created_at "NOT NULL DEFAULT now()"
        TIMESTAMPTZ updated_at "NOT NULL DEFAULT now()"
    }
    vault_items {
        UUID id PK
        UUID user_id FK "→users CASCADE"
        BYTEA ciphertext "NOT NULL — AEAD credential"
        BYTEA nonce "NOT NULL"
        TEXT item_type "NOT NULL DEFAULT login"
        BIGINT revision "NOT NULL DEFAULT 1"
        TIMESTAMPTZ created_at "NOT NULL DEFAULT now()"
        TIMESTAMPTZ updated_at "NOT NULL DEFAULT now()"
    }
    devices {
        UUID id PK
        UUID user_id FK "→users CASCADE"
        TEXT fingerprint_hash "NOT NULL — hashed"
        TEXT display_name "nullable"
        BOOLEAN trusted "NOT NULL DEFAULT false"
        TIMESTAMPTZ first_seen "NOT NULL DEFAULT now()"
        TIMESTAMPTZ last_seen "NOT NULL DEFAULT now()"
    }
    behavioral_baselines {
        UUID id PK
        UUID user_id FK "→users CASCADE"
        INTEGER feature_schema_version "NOT NULL"
        INTEGER model_version "NOT NULL"
        BYTEA model_blob_encrypted "NOT NULL — means+covariance"
        BYTEA model_nonce "NOT NULL"
        INTEGER sample_count "NOT NULL DEFAULT 0"
        TEXT status "NOT NULL DEFAULT enrolling CHECK"
        TEXT modality "NOT NULL DEFAULT keystroke CHECK (0005)"
        TIMESTAMPTZ created_at "NOT NULL DEFAULT now()"
        TIMESTAMPTZ updated_at "NOT NULL DEFAULT now()"
    }
    enrollment_samples {
        UUID id PK
        UUID user_id FK "→users CASCADE"
        JSONB feature_vector "NOT NULL — purged on activation"
        TIMESTAMPTZ captured_at "NOT NULL DEFAULT now()"
        INTEGER feature_schema_version "NOT NULL DEFAULT 1 (0002)"
        TEXT modality "NOT NULL DEFAULT keystroke CHECK (0005)"
    }
    risk_events {
        UUID id PK
        UUID user_id FK "nullable →users SET NULL"
        UUID device_id FK "nullable →devices SET NULL"
        TIMESTAMPTZ occurred_at "NOT NULL DEFAULT now()"
        TEXT ip_truncated "nullable — coarsened"
        TEXT geo_country "nullable"
        TEXT geo_region "nullable"
        JSONB signals "NOT NULL — per-signal score+reason"
        NUMERIC behavioral_score "nullable"
        NUMERIC context_score "nullable"
        NUMERIC composite_score "nullable (0003)"
        TEXT policy_band "nullable CHECK (0003)"
        TEXT action_taken "nullable (0003)"
        TEXT outcome "nullable"
    }
    sessions {
        UUID id PK
        UUID user_id FK "→users CASCADE"
        UUID device_id FK "nullable →devices SET NULL"
        TEXT token_hash "NOT NULL — raw token never stored"
        TEXT status "NOT NULL DEFAULT active CHECK"
        TIMESTAMPTZ created_at "NOT NULL DEFAULT now()"
        TIMESTAMPTZ expires_at "NOT NULL"
        TIMESTAMPTZ last_risk_check_at "nullable"
        BOOLEAN is_new_device "NOT NULL DEFAULT false (0003)"
        BOOLEAN step_up_confirmed "NOT NULL DEFAULT false (0006)"
    }
    login_failures {
        UUID id PK
        UUID user_id FK "nullable →users SET NULL"
        TEXT ip_truncated "nullable — coarsened"
        TIMESTAMPTZ occurred_at "NOT NULL DEFAULT now()"
    }
    totp_secrets {
        UUID user_id PK_FK "→users CASCADE"
        BYTEA secret_encrypted "NOT NULL — encrypted at rest"
        BYTEA nonce "NOT NULL"
        BOOLEAN confirmed "NOT NULL DEFAULT false"
        TIMESTAMPTZ created_at "NOT NULL DEFAULT now()"
        BIGINT last_used_step "nullable — replay watermark (0004)"
    }
    step_up_challenges {
        UUID id PK
        UUID user_id FK "→users CASCADE"
        UUID session_id FK "nullable →sessions CASCADE"
        TEXT method "NOT NULL CHECK totp|email_otp"
        TEXT status "NOT NULL DEFAULT pending CHECK"
        TIMESTAMPTZ created_at "NOT NULL DEFAULT now()"
        TIMESTAMPTZ expires_at "NOT NULL"
        TIMESTAMPTZ consumed_at "nullable"
        TEXT token_hash "nullable — hashed handle (0004)"
        UUID device_id FK "nullable →devices SET NULL (0004)"
        BOOLEAN is_new_device "NOT NULL DEFAULT false (0004)"
    }
```

Plus one runtime-only table the runner creates (not shown above, not a `.sql` migration):

```sql
CREATE TABLE schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4b. Every table, every column — the final shape

This is the *effective* schema after all six migrations apply. The originating migration is noted for
columns added after 0001. **"Server-opaque"** marks ciphertext/hash columns the server can never read;
everything else is plaintext metadata. The whole zero-knowledge claim rests on the right-hand
classification: there is no column anywhere holding a master password, a derived key, a plaintext
credential, or a raw behavioral capture.

### `users` — identity + public KDF parameters
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | metadata | PK; referenced by every per-user table. |
| `username` | TEXT | NO | — | metadata | UNIQUE login identifier. |
| `auth_key_hash` | TEXT | NO | — | **hash** | Argon2id hash of the **client-derived auth key** (never the master password). |
| `kdf_version` | INTEGER | NO | — | metadata | KDF parameter-set version (rotation). |
| `kdf_salt` | BYTEA | NO | — | metadata (public) | Per-user salt the client needs to re-derive keys. Not secret. |
| `kdf_params` | JSONB | NO | — | metadata (public) | `{memory_kib, iterations, parallelism}`. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | metadata | |

### `vault_keys` — the wrapped per-user vault key (1:1 with user)
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `user_id` | UUID | NO | — | metadata | **PK & FK** → `users(id)` CASCADE. The FK *is* the PK → exactly one row per user. |
| `wrapped_vault_key` | BYTEA | NO | — | **server-opaque** | Vault key encrypted by the client's encryption key. Server cannot unwrap. |
| `nonce` | BYTEA | NO | — | metadata | AEAD nonce used to wrap the vault key. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | metadata | Re-wrap time (master-password rotation re-wraps this row only). |

### `vault_items` — the vault itself (opaque blobs)
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | metadata | PK. |
| `user_id` | UUID | NO | — | metadata | FK → `users(id)` CASCADE; owner. |
| `ciphertext` | BYTEA | NO | — | **server-opaque** | AEAD ciphertext of the entire credential (name, username, password, url, notes). |
| `nonce` | BYTEA | NO | — | metadata | AEAD nonce for this item. |
| `item_type` | TEXT | NO | `'login'` | metadata | Item kind. |
| `revision` | BIGINT | NO | `1` | metadata | Optimistic-concurrency counter for sync. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
Index: `idx_vault_items_user (user_id)`.

### `devices` — known-device registry (new-vs-known signal)
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | metadata | PK. |
| `user_id` | UUID | NO | — | metadata | FK → `users(id)` CASCADE. |
| `fingerprint_hash` | TEXT | NO | — | **hash** | Hashed device fingerprint; raw fingerprint never stored. |
| `display_name` | TEXT | YES | — | metadata | Optional label. |
| `trusted` | BOOLEAN | NO | `FALSE` | metadata | |
| `first_seen` | TIMESTAMPTZ | NO | `now()` | metadata | |
| `last_seen` | TIMESTAMPTZ | NO | `now()` | metadata | |
Constraint: `UNIQUE (user_id, fingerprint_hash)` (drives the upsert).

### `behavioral_baselines` — fitted, encrypted per-user, per-modality model
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | metadata | PK. |
| `user_id` | UUID | NO | — | metadata | FK → `users(id)` CASCADE. |
| `feature_schema_version` | INTEGER | NO | — | metadata | Extractor schema the model was fitted under. |
| `model_version` | INTEGER | NO | — | metadata | Monotonic; re-fits bump it. |
| `model_blob_encrypted` | BYTEA | NO | — | **server-opaque** | Encrypted model: means + covariance + comparison models. **No raw captures.** |
| `model_nonce` | BYTEA | NO | — | metadata | AEAD nonce for the blob. |
| `sample_count` | INTEGER | NO | `0` | metadata | |
| `status` | TEXT | NO | `'enrolling'` | metadata | CHECK `('enrolling','active','retired')`. |
| `modality` | TEXT | NO | `'keystroke'` | metadata | CHECK `('keystroke','mouse')` — **0005**. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
Constraint (0005): `UNIQUE (user_id, modality, model_version)` (replaced the 0001 `(user_id, model_version)`).
Index (0005): `idx_baselines_user_modality_active (user_id, modality) WHERE status='active'` (partial; replaced the 0001 `idx_baselines_user_active`).

### `enrollment_samples` — ephemeral feature buffer (purged on activation)
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | metadata | PK. |
| `user_id` | UUID | NO | — | metadata | FK → `users(id)` CASCADE. |
| `feature_vector` | JSONB | NO | — | metadata (biometric-adjacent) | Position-indexed durations/geometry — never characters or pointer content. Deleted once the baseline goes `active`. |
| `captured_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
| `feature_schema_version` | INTEGER | NO | `1` | metadata | **0002**. |
| `modality` | TEXT | NO | `'keystroke'` | metadata | CHECK `('keystroke','mouse')` — **0005**. |
Indexes: `idx_enrollment_user (user_id)`; `idx_enrollment_user_modality (user_id, modality)` (0005).

### `risk_events` — per-login risk decision log (the evaluation dataset)
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | metadata | PK. |
| `user_id` | UUID | **YES** | — | metadata | FK → `users(id)` **SET NULL** — audit survives deletion. |
| `device_id` | UUID | YES | — | metadata | FK → `devices(id)` **SET NULL**. |
| `occurred_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
| `ip_truncated` | TEXT | YES | — | metadata (coarsened) | Truncated IP — never the full address. |
| `geo_country` | TEXT | YES | — | metadata | Coarse geo. |
| `geo_region` | TEXT | YES | — | metadata | Coarse geo. |
| `signals` | JSONB | NO | — | metadata | Per-signal `{score, reason}` — sub-scores + structured reasons; **no raw timings/IPs**. |
| `behavioral_score` | NUMERIC | YES | — | metadata | Aggregated behavioral sub-score. |
| `context_score` | NUMERIC | YES | — | metadata | Aggregated contextual sub-score. |
| `composite_score` | NUMERIC | YES | — | metadata | Combiner output; **NOT NULL dropped in 0003**. |
| `policy_band` | TEXT | YES | — | metadata | CHECK `('grant','step_up','deny')` (on non-NULL); **NOT NULL dropped in 0003**. |
| `action_taken` | TEXT | YES | — | metadata | **NOT NULL dropped in 0003**. |
| `outcome` | TEXT | YES | — | metadata | e.g. `step_up_passed` / `step_up_failed` / `denied`. |
Index: `idx_risk_events_user_time (user_id, occurred_at)`.

### `sessions` — authenticated sessions + continuous-auth state
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | metadata | PK. |
| `user_id` | UUID | NO | — | metadata | FK → `users(id)` CASCADE. |
| `device_id` | UUID | YES | — | metadata | FK → `devices(id)` SET NULL. |
| `token_hash` | TEXT | NO | — | **hash** | SHA-256 of the session bearer token; raw token never stored. |
| `status` | TEXT | NO | `'active'` | metadata | CHECK `('active','locked','revoked','expired')`. `locked` = continuous-auth spike. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
| `expires_at` | TIMESTAMPTZ | NO | — | metadata | Absolute expiry. |
| `last_risk_check_at` | TIMESTAMPTZ | YES | — | metadata | Last continuous-auth evaluation time. |
| `is_new_device` | BOOLEAN | NO | `FALSE` | metadata | **0003**. |
| `step_up_confirmed` | BOOLEAN | NO | `FALSE` | metadata | **0006** — gates `GET /risk/events` + the live score stream. |
Index: `idx_sessions_user (user_id)`.

### `login_failures` — append-only failed-login log (failure-velocity signal)
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | metadata | PK. |
| `user_id` | UUID | **YES** | — | metadata | FK → `users(id)` **SET NULL**; NULL when username unknown (enumeration-safe). |
| `ip_truncated` | TEXT | YES | — | metadata (coarsened) | Truncated IP — never the full IP, never the attempted password. |
| `occurred_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
Indexes: `idx_login_failures_user_time (user_id, occurred_at)`; `idx_login_failures_ip_time (ip_truncated, occurred_at)`.

### `totp_secrets` — per-user TOTP shared secret (1:1 with user)
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `user_id` | UUID | NO | — | metadata | **PK & FK** → `users(id)` CASCADE; one secret per user. |
| `secret_encrypted` | BYTEA | NO | — | **server-opaque** | TOTP shared secret, encrypted at rest (server-managed key, `secretbox.ts`). |
| `nonce` | BYTEA | NO | — | metadata | AEAD nonce for the secret. |
| `confirmed` | BOOLEAN | NO | `FALSE` | metadata | Gates step-up use until proven on setup. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
| `last_used_step` | BIGINT | YES | — | metadata | Replay watermark (last accepted time-step). **0004**. |

### `step_up_challenges` — short-lived second-factor handle
| Column | Type | Null | Default | Class | Notes |
|---|---|---|---|---|---|
| `id` | UUID | NO | `gen_random_uuid()` | metadata | PK. |
| `user_id` | UUID | NO | — | metadata | FK → `users(id)` CASCADE. |
| `session_id` | UUID | YES | — | metadata | FK → `sessions(id)` CASCADE. |
| `method` | TEXT | NO | — | metadata | CHECK `('totp','email_otp')`. |
| `status` | TEXT | NO | `'pending'` | metadata | CHECK `('pending','passed','failed','expired')`. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | metadata | |
| `expires_at` | TIMESTAMPTZ | NO | — | metadata | 5-min TTL (set by the service). |
| `consumed_at` | TIMESTAMPTZ | YES | — | metadata | |
| `token_hash` | TEXT | YES | — | **hash** | Hashed challenge handle; raw handle never stored. **0004**. |
| `device_id` | UUID | YES | — | metadata | FK → `devices(id)` SET NULL; device the pending login is for. **0004**. |
| `is_new_device` | BOOLEAN | NO | `FALSE` | metadata | **0004**. |
Indexes: `idx_stepup_user (user_id)`; `idx_stepup_token (token_hash)` (0004).

> **Zero-knowledge proof, at the DB layer.** The only `BYTEA`/`TEXT` columns holding sensitive data
> are `*_encrypted`, `wrapped_*`, `ciphertext`, and `*_hash` (auth key, fingerprint, session and
> challenge tokens). None of these is reversible by the server: the ciphertext columns are sealed with
> keys the server never sees, and the hash columns are one-way. There is **no** column for a master
> password, a derived encryption/vault key, a plaintext credential field, or a raw
> keystroke/mouse capture. The `email_otp` method value is allowed by a CHECK constraint but is
> schema headroom — not wired anywhere (see [§6](#6-gotchas--invariants)).

---

## 5. How it works: the migration runner, then the schema

Follow the data, in the order the code runs.

### 5.1 Applying migrations (`npm run migrate`)

1. [`migrate.ts`](../../migrations/migrate.ts) reads `DATABASE_URL`; **throws** if unset (fail loud,
   not silent).
2. Connects a single `pg.Client`.
3. `CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ
   NOT NULL DEFAULT now())`.
4. `SELECT filename FROM schema_migrations` → an in-memory `Set` of already-applied names.
5. `readdirSync(MIGRATIONS_DIR)` → keep `*.sql` → **`.sort()`** (lexical filename order — this is why
   files are zero-padded `0001…0006`) → drop already-applied → `pending`.
6. If `pending` is empty: log "No pending migrations." and stop (idempotent).
7. For each pending file, in order: `BEGIN` → run the **whole** SQL file as one statement batch →
   `INSERT INTO schema_migrations (filename) VALUES ($1)` (the filename is a **bound parameter**) →
   `COMMIT`. Any error → `ROLLBACK` and rethrow (so a bad migration leaves the DB untouched and the
   process exits non-zero).

**Worked example.** Fresh DB, files `0001…0006` on disk. `schema_migrations` is empty, so all six are
pending and run in order. Run again immediately: the `Set` now holds all six, `pending` is empty,
output is "No pending migrations." Add `0007_foo.sql`: only `0007` is pending and applied. There is no
"down" migration and no checksum — an already-applied file is simply never re-read (so editing an old
file has **no effect** on a DB that already ran it; that is the forward-only rule, enforced by
convention).

### 5.2 Reading/writing at runtime

Routes call a service; the service calls a repository; the repository runs one parameterized query
against the `Db` (pool or transaction client). Multi-statement work that must be atomic (e.g. issuing
a session) goes through [`withTransaction`](../../apps/server/src/repositories/pool.ts). See
[Server & API](09-server-and-api.md) for the route→service→repository flow and
[Decision & policy](07-decision-and-policy.md) / [Continuous auth](08-continuous-auth.md) for how
`risk_events` and `sessions.status` are written.

---

## 6. Gotchas & invariants

- **IDOR defence is in the repository, not just the route.** Every query that touches user data
  carries `WHERE user_id = $n` — see, e.g., `vault-items.getForUser` (`WHERE user_id = $1 AND id =
  $2`), `devices.findForUser`, `risk-events.listByUserPaged`. Token-keyed lookups
  (`sessions.findActiveByTokenHash`, `step_up_challenges.findPendingByTokenHash`) are bound to a
  single hashed secret that itself maps to one user. **What breaks if you skipped it:** passing
  another user's item `id` would let you read their ciphertext — a classic IDOR. The route also
  returns a uniform not-found for not-owned items, so existence doesn't leak either.

- **Two FKs use `ON DELETE SET NULL` on purpose: `risk_events.user_id` and `login_failures.user_id`
  (and the optional `device_id` links).** These are **telemetry / the evaluation dataset**, so when an
  account is deleted the rows must **survive** (with `user_id` blanked) rather than CASCADE away. Every
  other user-owned table (`vault_*`, `devices`, `behavioral_baselines`, `enrollment_samples`,
  `sessions`, `totp_secrets`, `step_up_challenges`) uses `ON DELETE CASCADE` because that data is
  meaningless once the user is gone. `login_failures.user_id` is *also* NULL at write time for an
  unknown username — enumeration-safe.

- **The `xmax = 0` insert-vs-update trick.** `devices.enroll` does `INSERT ... ON CONFLICT (...) DO
  UPDATE SET last_seen = now() RETURNING id, (xmax = 0) AS is_new`. `xmax` is a PostgreSQL system
  column: on a freshly inserted row it is `0`; on a row updated by the conflict path it is non-zero.
  So `xmax = 0` cheaply means "this was a brand-new device" — the authoritative new-device signal,
  read once at login and stored on the session/challenge, never re-inferred from timestamps later.

- **Optimistic concurrency in `vault_items.update`.** The UPDATE only fires when `revision =
  expectedRevision`; on no rows it does a second `SELECT 1 ... WHERE user_id AND id` to tell a
  `conflict` (stale revision, row still there) from `not_found` (absent or someone else's). **What
  breaks naively:** a blind last-writer-wins UPDATE would silently clobber a concurrent edit during
  sync.

- **Atomic, single-statement races for replay/single-use.** `totp_secrets.setLastUsedStep` is
  `UPDATE ... WHERE user_id = $1 AND (last_used_step IS NULL OR last_used_step < $2)` and returns
  whether *this* call advanced it — a `false` means a concurrent verify already consumed this (or a
  later) step, so the caller must treat its own attempt as a replay. Likewise
  `step_up_challenges.consume` is `UPDATE ... WHERE status = 'pending'` — exactly one caller can win.
  A single conditional UPDATE is the source of truth, so no explicit lock/transaction is needed; this
  closes the read-then-write TOCTOU race (RFC 6238 §5.2 anti-replay).

- **Continuous-auth lock is fail-closed and idempotent.** `sessions.markLocked` does `UPDATE ... SET
  status = 'locked' WHERE id = $1 AND status = 'active'`. After it,
  `findActiveByTokenHash` (which filters `status='active'`) no longer authenticates the token, so all
  vault ops require a fresh re-unlock. A second lock is a harmless no-op.

- **node-pg type quirks.** `BIGINT`/`int8` (`vault_items.revision`, `totp_secrets.last_used_step`)
  and `NUMERIC` (`risk_events.*_score`) come back as **strings** and are converted
  with `Number(...)` in `toRecord` mappers. JSONB (`kdf_params`, `feature_vector`, `signals`) is
  parsed to JS objects automatically; on write it is passed as a `$n::jsonb` parameter of
  `JSON.stringify(...)` — never string-concatenated SQL.

- **The biometric-adjacent blob is not returned by the status path.** `behavioral-baselines` exposes
  metadata (`findActiveByUser`) separately from the encrypted model (`findActiveModel`), so the model
  blob is only fetched for scoring/tests — never handed back over a status API.

- **`email_otp` is schema headroom.** Both `step_up_challenges.method` and `ChallengeMethod` in the
  repo allow `'email_otp'`, but only `'totp'` is wired (matches recon notes §12 open question). Treat
  it as planned, not implemented.

- **No pending-migration startup guard.** Nothing checks at server boot that the running DB is fully
  migrated; a stale dev DB missing a column surfaces as a 500 at query time (recon notes §11.4). CI
  and tests use a fresh ephemeral Postgres that always applies every migration, so this only bites a
  stale dev database — run `npm run migrate`.

---

## 7. Reconciling against `docs/schema-reference.md`

[`docs/schema-reference.md`](../schema-reference.md) is a hand-generated consolidated schema. It is
**accurate for migrations 0001–0005** — columns, types, defaults, CHECKs, the FK/ON-DELETE table, and
the index notes all match the migration files I read. **One real drift:**

> ⚠️ **`docs/schema-reference.md` predates migration 0006 and omits `sessions.step_up_confirmed`.** Its
> header says "generated from the actual migrations in `migrations/` (0001–0005)", its migration
> inventory (§1) stops at 0005, and its `sessions` definition (lines 146-157, 292-303) does **not**
> list `step_up_confirmed BOOLEAN NOT NULL DEFAULT FALSE` (added by
> [`0006_step_up_confirmed_session.sql`](../../migrations/0006_step_up_confirmed_session.sql)). This
> doc's [§4b](#4b-every-table-every-column--the-final-shape) `sessions` table is the up-to-date
> shape. To confirm against a live DB: `\d sessions` in `psql` should show the `step_up_confirmed`
> column. **Recommended fix:** regenerate `schema-reference.md` to include 0006.

Everything else in `schema-reference.md` reconciles cleanly, including its useful extra observations:
the one runtime-only `schema_migrations` table (created by the runner, not a `.sql` file), the
natural primary keys on `vault_keys.user_id` / `totp_secrets.user_id` (the FK *is* the PK → 1:1), and
the partial active-baseline index. This doc agrees with all of those.

---

## 8. How it connects

- **Up to the services/routes.** The repositories are the floor of the
  route → service → repository stack ([Server & API](09-server-and-api.md)). Services compose
  repository calls; routes never touch SQL.
- **Crypto boundary.** The ciphertext/hash columns are produced elsewhere: vault item/key ciphertext
  by the Rust core ([Cryptographic core](04-cryptographic-core.md), [Vault & sync](05-vault-and-sync.md));
  `auth_key_hash` by the server's Argon2id-of-the-auth-key step ([Server & API](09-server-and-api.md));
  `secret_encrypted`/`model_blob_encrypted` by the server-managed AES-256-GCM secretbox/baseline-crypto
  ([Behavioral engine](06-behavioral-engine.md), [Decision & policy](07-decision-and-policy.md)).
- **The risk pipeline writes here.** `risk_events`, `login_failures`, `devices`, `sessions`, and the
  step-up tables are the durable state behind
  [Decision & policy](07-decision-and-policy.md) and [Continuous auth](08-continuous-auth.md). The
  `risk_events` table is explicitly "the evaluation dataset" used in the thesis evaluation
  ([Algorithms deep-dive](14-algorithms-deep-dive.md)).
</content>
</invoke>
