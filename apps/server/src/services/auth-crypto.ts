// Server-side identity crypto (PROJECT.md §1, ADR-0001).
//
// This is NOT vault crypto (that lives in Rust, §1.2). These are the server's
// auth operations: hashing the client-derived auth key (treated like a password),
// the user-enumeration mitigation, and session-token hashing. The server never
// sees the master password or any derived encryption key.
import { createHash, createHmac, randomBytes } from 'node:crypto';

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';

// @node-rs/argon2's Algorithm is an ambient const enum (can't be referenced under
// isolatedModules), so we use its numeric value. Argon2id = 2. A test asserts the
// produced PHC string starts with `$argon2id$`, so a wrong value can't slip by.
const ARGON2ID: Algorithm = 2 as Algorithm;

// Argon2id parameters for hashing the auth key server-side (defense in depth,
// ADR-0001). The auth key is already high-entropy (256-bit, derived client-side),
// so brute force is infeasible regardless; these are deliberately moderate.
const AUTH_HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

// A FIXED, precomputed dummy hash used to equalize unknown-user login timing.
// It is a static Argon2id PHC string with the same params as real hashes, so the
// unknown-user verify does the same work as a real verify with NO extra hash
// build on the request path — the cold-start timing distinguisher a lazily-built
// hash would create (verify + build on the first request) is eliminated.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$QEvxkyFz1ENHylLvNyNSkg$ztR9oOpMfE16wHAiMhB9bqV5obmE+mIT21BLeHhYrd0';

// The auth key is hashed/verified in its canonical base64 string form (the wire
// representation). @node-rs/argon2 treats a Buffer password as UTF-8 and rejects
// non-UTF-8 bytes, so passing the base64 string is both correct and consistent
// between register (hash) and login (verify).

/** Argon2id-hash the auth key for storage (PHC string with its own random salt). */
export async function hashAuthKey(authKeyB64: string): Promise<string> {
  return argon2Hash(authKeyB64, AUTH_HASH_OPTIONS);
}

/** Constant-time verify of an auth key against a stored hash (no early return). */
export async function verifyAuthKey(storedHash: string, authKeyB64: string): Promise<boolean> {
  return argon2Verify(storedHash, authKeyB64);
}

/**
 * Run a verify against a fixed dummy hash so the unknown-user path takes the same
 * time as the known-user path (no early return that would leak account existence).
 */
export async function verifyAgainstDummy(authKeyB64: string): Promise<void> {
  try {
    await argon2Verify(DUMMY_HASH, authKeyB64);
  } catch {
    // Result is irrelevant — this call exists only to equalize timing.
  }
}

/**
 * Deterministic dummy KDF salt for an unknown username (ADR-0007). Stable per
 * (secret, username), so repeated prelogins for an absent account always return
 * the same salt — present and absent accounts are indistinguishable. Requires a
 * SECRET server key; if the key leaked, an attacker could recompute dummy salts
 * and distinguish accounts, defeating the mitigation.
 */
export function deterministicDummySalt(secret: string, username: string): Buffer {
  return createHmac('sha256', secret).update(username, 'utf8').digest().subarray(0, 16);
}

/** Generate an opaque, high-entropy session token (256-bit). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash a session token for storage. The token is high-entropy, so SHA-256 suffices. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
