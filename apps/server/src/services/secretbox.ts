// Generic authenticated at-rest encryption (ADR-0009, ADR-0012). AES-256-GCM
// (AEAD only, PROJECT.md §3) under a SERVER-managed key, with a fresh 96-bit IV
// per op and an AAD label binding the ciphertext to a domain + context (e.g. a
// user id) for domain separation. Output is ciphertext‖tag (ADR-0005 layout).
// Used for behavioral baselines (ADR-0009) and TOTP secrets (ADR-0012).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  /** ciphertext‖tag. */
  ciphertext: Buffer;
  /** The random 96-bit IV. */
  nonce: Buffer;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error('secretbox key must be 32 bytes');
  }
}

/** Seal `plaintext` under `key`, binding it to `aad` (domain + context label). */
export function seal(plaintext: Buffer, key: Buffer, aad: string): SealedSecret {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([body, tag]), nonce: iv };
}

/**
 * Open a sealed secret. Throws on a wrong key, a tampered blob, or a mismatched
 * AAD (the GCM tag check fails) — never returns unauthenticated plaintext.
 */
export function open(sealed: SealedSecret, key: Buffer, aad: string): Buffer {
  assertKey(key);
  if (sealed.ciphertext.length < TAG_BYTES) {
    throw new Error('ciphertext too short');
  }
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
