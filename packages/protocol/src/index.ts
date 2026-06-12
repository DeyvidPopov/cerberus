// Documented cryptographic constants and wire-format identifiers (PROJECT.md §2).
//
// CONSTANTS ONLY — no crypto logic lives in this package, or anywhere outside the
// Rust core (PROJECT.md §1.2). All values trace to ADR-0001.
//
// The Argon2id parameters below are PINNED (ADR-0001): benchmarked on target
// hardware to ~0.5 s per derivation. Raising them later bumps `KDF_VERSION` so
// existing vaults remain openable. Keep these in sync with the Rust core's
// `KdfParams::V1` (apps/desktop/src-tauri/src/crypto/kdf.rs).

/** KDF parameter-set version, stored per user so parameters can be raised later. */
export const KDF_VERSION = 1;

/** Argon2id parameters (ADR-0001), pinned after benchmarking (~521 ms/derivation). */
export const ARGON2ID_PARAMS = {
  /** Memory cost in kibibytes (224 MiB). */
  memoryKib: 229376,
  /** Iterations (time cost). */
  iterations: 3,
  /** Degree of parallelism. */
  parallelism: 1,
} as const;

/** Key-separation KDF: HKDF with SHA-256 and distinct info labels (ADR-0001). */
export const HKDF_HASH = 'SHA-256';

/** Distinct HKDF `info` labels keep the auth and encryption keys independent. */
export const HKDF_INFO = {
  authKey: 'cerberus/auth-key/v1',
  encryptionKey: 'cerberus/encryption-key/v1',
} as const;

/**
 * Authenticated symmetric encryption algorithm. AEAD only — no unauthenticated
 * modes, ever (ADR-0001). XChaCha20-Poly1305 is preferred for its large random
 * nonce; AES-256-GCM is the documented alternative.
 */
export const AEAD_ALGORITHM = 'XChaCha20-Poly1305';
