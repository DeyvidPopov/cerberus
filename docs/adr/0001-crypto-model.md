# ADR-0001 — Cryptographic Model

- Status: **Accepted**
- Context: foundational; gates all vault work (Phase 1).
- Related: `PROJECT.md` §1, §3; `docs/threat-model.md` (A1, A4, A7).

## Context

Cerberus is zero-knowledge: the server must never see the master password, derived keys, or
vault plaintext. We need a key hierarchy that (a) proves identity to the server without
revealing the master password, (b) encrypts credentials client-side, and (c) lets the master
password change without re-encrypting every credential.

## Decision

**Key hierarchy.**

```
master password ──Argon2id(salt, params)──► master key
master key ──HKDF──► auth key        (sent to server; server stores Argon2id hash of it)
master key ──HKDF──► encryption key  (never leaves client)
encryption key ──unwraps──► vault key (random per user, stored AEAD-wrapped)
vault key ──AEAD──► per-credential ciphertext
```

**Primitives.**

- KDF: **Argon2id** (RFC 9106), version 0x13. **Pinned parameters (`kdf_version = 1`):**
  memory = **224 MiB** (229 376 KiB), iterations = **3**, parallelism = **1**, 32-byte output.
  - _Origin:_ the ADR's original starting point was 64 MiB / t=3 / p=1, which benchmarked at
    ~134 ms on the development machine — well under the ~0.5 s target. Memory cost was raised
    (favouring memory-hardness against GPU/ASIC brute force, threat A7) to **224 MiB**, which
    measures **~521 ms per derivation** (release build, mean of 5 runs) — on target.
  - Raising these later bumps `kdf_version` so existing vaults still open with their stored params.
  - Mirrored in `packages/protocol` (`ARGON2ID_PARAMS`, `KDF_VERSION`) and the Rust core
    (`crypto::kdf::KdfParams::V1`, `crypto::kdf::KDF_VERSION`).
- Key separation: **HKDF-SHA-256** to derive auth key and encryption key from the master key
  (distinct `info` labels), so the two are cryptographically independent.
- Symmetric encryption: **AEAD only** — XChaCha20-Poly1305 (preferred for its large random
  nonce) or AES-256-GCM. No unauthenticated modes, ever.
- Server-side auth-key storage: the auth key is treated like a password — stored as an
  Argon2id hash with its own server-side salt (defense in depth).

**Operational rules.**

- Fresh random nonce per encryption op; nonce reuse is a hard bug.
- `kdf_version` is stored per user so parameters can be raised later without breaking old vaults.
- Changing the master password **re-wraps the vault key**; it does not re-encrypt credentials.
- All secret types in Rust are `Zeroize`/`ZeroizeOnDrop` with redacted `Debug`.
- All secret comparisons are constant-time.

## Consequences

- A DB dump yields only ciphertext + an auth-key hash → satisfies threat A4 for vault data.
- Master-password rotation is cheap (re-wrap one key).
- The KDF cost is a deliberate UX/security tradeoff; the benchmarked final value is recorded here.

## Alternatives considered

- **Single key, no auth/encryption split** — rejected; sending anything derived directly from
  the encryption key to the server weakens the zero-knowledge boundary.
- **PBKDF2 / bcrypt as KDF** — rejected; Argon2id has stronger memory-hardness against GPU/ASIC
  brute force (threat A7).
- **AES-CBC / unauthenticated modes** — rejected; no integrity, incompatible with tamper-evidence.
