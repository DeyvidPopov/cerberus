// At-rest encryption for behavioral baselines (ADR-0002, ADR-0009).
//
// This encrypts the FITTED MODEL (mean + covariance) before it is stored — NOT
// vault crypto (that lives in Rust, PROJECT.md §1.2). The key here is a
// SERVER-MANAGED key, separate from any user vault key: the server must be able
// to decrypt the model to score in M7 (the documented ADR-0002 limitation).
//
// AES-256-GCM (AEAD only, PROJECT.md §3). Fresh random 96-bit IV per op; output
// is ciphertext‖tag mirroring the ADR-0005 layout. The AAD binds the blob to the
// pseudonymous user id, so a stolen blob cannot be decrypted under another user's
// id nor swapped between users (domain separation, ADR-0005 philosophy).
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD_LABEL = 'cerberus/behavioral-baseline/v1';

export interface EncryptedBlob {
  /** ciphertext‖tag (the GCM tag appended, ADR-0005 layout). */
  ciphertext: Buffer;
  /** The random 96-bit IV. */
  nonce: Buffer;
}

function aad(userId: string): Buffer {
  return Buffer.from(`${AAD_LABEL}:${userId}`, 'utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error('baseline encryption key must be 32 bytes');
  }
}

/** Encrypt a fitted-model blob, binding it to `userId` via the AAD. */
export function encryptBaselineModel(plaintext: Buffer, userId: string, key: Buffer): EncryptedBlob {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(userId));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([body, tag]), nonce: iv };
}

/**
 * Decrypt a fitted-model blob for `userId`. Throws on a wrong key, a tampered
 * blob, or a mismatched user id (the AAD fails the GCM tag check) — never returns
 * unauthenticated plaintext.
 */
export function decryptBaselineModel(blob: EncryptedBlob, userId: string, key: Buffer): Buffer {
  assertKey(key);
  if (blob.ciphertext.length < TAG_BYTES) {
    throw new Error('ciphertext too short');
  }
  const body = blob.ciphertext.subarray(0, blob.ciphertext.length - TAG_BYTES);
  const tag = blob.ciphertext.subarray(blob.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, blob.nonce);
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Constant-time equality (exposed for tests asserting blob/key handling). */
export function bytesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
