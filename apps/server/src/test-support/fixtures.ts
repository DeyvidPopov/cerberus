// Test fixtures. Registration material is opaque to the server (it stores it),
// so tests use random bytes — the server never validates the client-side crypto.
import { randomBytes } from 'node:crypto';

import { ARGON2ID_PARAMS, KDF_VERSION } from '@cerberus/protocol';
import type { RegisterRequest } from '@cerberus/shared-types';

export function uniqueUsername(prefix = 'user'): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export function makeRegistration(username: string): {
  body: RegisterRequest;
  authKey: string;
} {
  const authKey = randomBytes(32).toString('base64');
  const body: RegisterRequest = {
    username,
    authKey,
    kdfVersion: KDF_VERSION,
    kdfSalt: randomBytes(16).toString('base64'),
    kdfParams: {
      memoryKib: ARGON2ID_PARAMS.memoryKib,
      iterations: ARGON2ID_PARAMS.iterations,
      parallelism: ARGON2ID_PARAMS.parallelism,
    },
    wrappedVaultKey: randomBytes(48).toString('base64'),
    wrappedVaultKeyNonce: randomBytes(24).toString('base64'),
  };
  return { body, authKey };
}

export function deviceFingerprintHash(): string {
  return randomBytes(32).toString('base64');
}
