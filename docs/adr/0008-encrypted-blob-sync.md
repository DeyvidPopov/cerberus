# ADR-0008 — Encrypted Blob Sync & Concurrency

- Status: **Accepted**
- Context: Milestone 5 (server-side encrypted blob sync).
- Related: PROJECT.md §1, §4.3; ADR-0001 (crypto), ADR-0005 (wire format), ADR-0007 (sessions);
  `migrations/0001_initial_schema.sql` (`vault_items`, `vault_keys`).

## Context

Credentials must sync across a user's devices through the server while the server stays
zero-knowledge: it stores and serves only opaque ciphertext and never decrypts. Concurrent edits
from two devices must not silently clobber each other.

## Decision

1. **Opaque blobs, ADR-0005 wire format as-is.** A vault item is
   `{ id, ciphertext, nonce, item_type, revision }`. `ciphertext`/`nonce` are the AEAD blob
   (XChaCha20-Poly1305, ADR-0005); the server stores and returns only these plus non-secret
   metadata (`item_type`, `revision`, timestamps). It never decrypts.

2. **Client-owned ids.** The client supplies the item `id` (a UUID) on create, so local and server
   ids agree across devices and offline creation needs no server round-trip to mint an id.

3. **Revision-based optimistic concurrency.** Each item has a monotonic integer `revision` starting
   at 1. `PUT /vault/items/:id` carries the base revision the edit was made on; the server bumps to
   `revision + 1` **only if** the stored revision matches, otherwise returns **409**. The client
   surfaces the conflict (the edit must be re-based on the fresh blob) and never silently
   overwrites. This is deliberately minimal — blob-level, not field-level merge.

4. **Fresh-client bootstrap order (the Phase-1 exit path):**
   `login → GET /vault/key → unwrap (encryption key derived from the master password) →
   GET /vault/items → decrypt`. A fresh client with only the username + master password recovers
   the full vault. (`login` also returns the wrapped key, but `GET /vault/key` is the canonical
   bootstrap step so re-sync needs no re-login.)

5. **Authorization is per-user and enforced in the repository.** Every query is scoped to the
   authenticated `user_id` in its `WHERE` clause (not only in the route) — defense against IDOR.
   Cross-user access returns **404** (uniform with genuinely-absent items, so item existence is not
   leaked). All sync endpoints require a valid session (ADR-0007) and are rate-limited per user.

## Consequences

- "Create on one client, fetch + decrypt on a fresh client" works (verified by the headline E2E,
  which drives the real Rust crypto + the real server over an ephemeral Postgres).
- A DB dump yields only ciphertext + metadata (server-blindness asserted in tests).
- Concurrent edits are safe: the second writer gets a 409 and must rebase.

## Alternatives considered

- **`updated_at` timestamps for concurrency** — rejected; clock skew and equal-timestamp races make
  it unreliable. A monotonic per-item revision is exact.
- **Field-level / CRDT merge** — out of scope; blob-level revision conflict is correct and simple
  for credentials. Noted as future work if richer merge is needed.
- **Server-assigned item ids** — rejected; the client needs stable ids for offline creation and
  cross-device identity.
- **Returning metadata-only lists then fetching each blob** — rejected for now; the list returns
  full blobs so pull is a single round-trip (`GET /vault/items/:id` still exists for single fetch).
