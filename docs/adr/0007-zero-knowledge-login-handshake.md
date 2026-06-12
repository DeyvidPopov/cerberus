# ADR-0007 — Zero-Knowledge Login Handshake & User-Enumeration Mitigation

- Status: **Accepted**
- Context: Milestone 4 (identity & zero-knowledge login).
- Related: PROJECT.md §1, §4.3; ADR-0001 (key hierarchy); `docs/threat-model.md` (A2, A4, A7);
  `migrations/0001_initial_schema.sql` (`users`, `vault_keys`, `devices`, `sessions`).

## Context

Login must prove identity to the server without the server ever seeing the master password or
any derived encryption key (PROJECT.md §1). Because the per-user KDF salt/params are needed to
derive the auth key but are stored server-side, the client must fetch them before deriving —
which risks leaking whether an account exists (user enumeration).

## Decision

**The handshake is prelogin → derive → verify:**

1. **prelogin(username) → { kdfVersion, kdfSalt, kdfParams }.** The client needs these to derive
   its keys. For an UNKNOWN username the server returns **deterministic dummy params** instead of
   an error: `kdfSalt = HMAC-SHA256(enumerationSecret, username)[..16]`, with the current pinned
   `kdfVersion`/`kdfParams`. The response shape, version, and params are identical to a real
   account, and the dummy salt is stable across calls — so present and absent accounts are
   indistinguishable. The endpoint is rate-limited.
2. **derive (client, Rust).** Argon2id(masterPassword, salt, params) → master key → HKDF → auth
   key (ADR-0001). Only the auth key leaves the device.
3. **login(username, authKey, deviceFingerprintHash) → verify.** The server verifies the auth key
   in **constant time** with Argon2id `verify` against the stored hash. For an unknown user it runs
   a verify against a **fixed, precomputed static dummy hash** (no early return, and no
   lazily-built hash on the request path), so the unknown-user and wrong-password paths are
   timing-indistinguishable even on a cold process. On success it enrolls the device, issues a
   session token (storing only its SHA-256 hash), and returns the opaque wrapped vault key for the
   client to unwrap locally.

**Server storage (ADR-0001).** Only an Argon2id hash of the auth key (with its own server-side
salt, PHC string), the public KDF params/salt, and the opaque wrapped vault key. Never the master
password, never a derived encryption key, never a plaintext auth key.

**Registration** is explicit (replacing M3's auto-init) and requires a password-confirmation field
client-side. A duplicate username legitimately returns 409 (registration is not an enumeration
oracle the way prelogin is — but see consequences).

**Device enrollment.** The client sends a hashed device fingerprint; an unknown fingerprint
creates a `devices` row (`trusted=false`), a known one bumps `last_seen`. Recorded now as
groundwork for the later "new device" context signal — no scoring yet. The raw fingerprint never
leaves the device.

## Consequences

- The server is zero-knowledge for identity: a DB dump yields only an auth-key hash + opaque
  ciphertext (threat A4), and brute force is throttled by Argon2id + rate limits (A7).
- prelogin is not a user-enumeration oracle, provided `enumerationSecret` stays secret (if it
  leaked, an attacker could recompute dummy salts and distinguish accounts — so production startup
  refuses the dev default).
- _Honest limitation:_ registration still reveals a taken username (409). Mitigating that (e.g.
  email-verification-first signup) is future work; prelogin/login — the repeatable probes — are the
  ones hardened here.
- _Honest limitation:_ the per-process in-memory rate-limit/lockout store does not coordinate across
  instances; a multi-instance deployment needs a shared store (e.g. Redis).
- _Honest limitation (targeted lockout DoS):_ account lockout is keyed on the username alone, so an
  unauthenticated party who knows a victim's username can deliberately fail logins to lock that
  account for the lockout window (availability-only; no auth bypass, no data exposure). This is the
  inherent tradeoff of per-account lockout; future hardening could add per-(account, IP) tracking,
  non-hard-locking exponential backoff, or self-service unlock.
- _Honest limitation (per-IP behind a proxy):_ the per-IP limit keys on `req.ip`. The app does not
  set Express `trust proxy` (current intended shape is single-instance / direct connection). Before
  deploying behind a reverse proxy, configure `trust proxy` to the known hop(s) so `req.ip` is the
  real client — and never blindly trust `X-Forwarded-For` (it is client-spoofable).
- _Honest limitation (fixed-window limiter):_ the per-IP limiter is a fixed-window counter, so up to
  ~2× the limit can pass across a window boundary. The per-account lockout (consecutive failures, no
  window reset) is the real brute-force control and is unaffected; moving to a sliding-window /
  token-bucket is future hardening, most relevant once the store moves to Redis.

## Alternatives considered

- **Augmented PAKE (e.g. OPAQUE)** — stronger (no salt-fetch enumeration surface at all), but a
  larger dependency and protocol surface than this thesis needs now; noted as future work.
- **Return 404 for unknown usernames at prelogin** — rejected; a blatant enumeration oracle.
- **Per-request random dummy salt** — rejected; a salt that changes across calls for the same
  username distinguishes absent accounts from present ones.
