# ADR-0005 — Cryptographic Wire Format & Domain Separation

- Status: **Accepted**
- Context: emerged from Milestone 2. These are de-facto contracts that downstream persistence
  and sync (Milestone 3+) will depend on; pin them before any blob is stored or synced.
- Related: ADR-0001; `packages/protocol`.

## Context

M2 produced an on-the-wire ciphertext layout and a set of domain-separation labels, and made
an HKDF key-derivation policy choice. Once a credential or wrapped vault key is persisted or
synced, these become a frozen format: changing them later means migrating every stored vault.
They must be pinned and versioned now.

## Decision

**Ciphertext layout (`AeadCiphertext`).** XChaCha20-Poly1305: a 24-byte random nonce followed
by the combined ciphertext‖tag (16-byte Poly1305 tag). This is the canonical on-disk / on-wire
representation, defined once in `packages/protocol` and versioned.

**AAD domain-separation labels.** Each encryption context binds a distinct AAD label so a blob
from one context can never be accepted in another:

- `cerberus/vault-key-wrap/v1` — wrapping the vault key under the encryption key.
- `cerberus/credential/v1` — encrypting an individual credential under the vault key.
  New contexts get new labels; format changes bump the `/vN` suffix rather than reusing one.

**HKDF salt policy.** HKDF-SHA-256 derives the auth key and the encryption key from the master
key with **salt = none**; key separation relies on distinct `info` labels over a high-entropy
master key. This is RFC 5869-compliant for high-entropy input keying material and is the
intended design — recorded here so it is not second-guessed as a missing salt.

**Versioning.** All of the above are constants in `packages/protocol` as the single source of
truth, each carrying a version so any future format change is an explicit version bump plus a
migration — never a silent break of stored blobs.

## Consequences

- Stored and synced blobs have a stable, versioned, self-describing format.
- The server never parses these blobs (they stay opaque), but format stability is what makes
  "create on one client, decrypt on a fresh client" (the Phase 1 exit criterion) sound.
- Cross-context confusion attacks are blocked by the AAD labels.

## Alternatives considered

- **No version field** — rejected; the format could not evolve safely once data exists.
- **Separate detached nonce/tag fields** — rejected; the combined `ct‖tag` the AEAD crate
  provides is simpler and equivalent, with the nonce prepended.
