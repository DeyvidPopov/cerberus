// TOTP service (ADR-0012): manage a user's second factor. Setup generates a secret
// and stores it ENCRYPTED at rest (secretbox, server-managed key) as UNCONFIRMED;
// confirm proves possession before it becomes usable; verify is the step-up check.
// Both confirm and verify are REPLAY-PROTECTED via a monotonic last-used time-step.
// The master password is never involved (zero-knowledge intact).
import type { Pool } from 'pg';

import type { TotpConfig } from '../risk/config';
import { createTotpSecretsRepository } from '../repositories/totp-secrets';
import { createUsersRepository } from '../repositories/users';
import { open, seal } from './secretbox';
import { base32Encode, generateTotpSecret, provisioningUri, verifyTotp } from './totp';

const AAD_LABEL = 'cerberus/totp-secret/v1';
const ISSUER = 'Cerberus';

export interface TotpServiceDeps {
  pool: Pool;
  encryptionKey: Buffer; // server-managed (shared with baseline at-rest key)
  config: TotpConfig;
}

export interface TotpSetup {
  provisioningUri: string;
  /** Base32 secret for manual entry (also embedded in the URI). */
  secret: string;
}

export type TotpResult = { ok: true } | { ok: false; reason: 'no_totp' | 'bad_code' | 'replay' };

function aad(userId: string): string {
  return `${AAD_LABEL}:${userId}`;
}

export function createTotpService(deps: TotpServiceDeps) {
  const { pool, encryptionKey, config } = deps;

  function decryptSecret(record: { secretEncrypted: Buffer; nonce: Buffer }, userId: string): Buffer {
    return open({ ciphertext: record.secretEncrypted, nonce: record.nonce }, encryptionKey, aad(userId));
  }

  return {
    /** Whether the user has a CONFIRMED second factor (drives the M10 enrolment nudge). */
    async status(userId: string): Promise<{ confirmed: boolean }> {
      const confirmed = await createTotpSecretsRepository(pool).hasConfirmed(userId);
      return { confirmed };
    },

    /** Generate + store a new (unconfirmed) secret; return the provisioning URI. */
    async setup(userId: string): Promise<TotpSetup> {
      const secret = generateTotpSecret();
      const sealed = seal(secret, encryptionKey, aad(userId));
      await createTotpSecretsRepository(pool).upsert({
        userId,
        secretEncrypted: sealed.ciphertext,
        nonce: sealed.nonce,
      });
      const user = await createUsersRepository(pool).findById(userId);
      const account = user?.username ?? userId;
      return {
        provisioningUri: provisioningUri(secret, account, ISSUER, config),
        secret: base32Encode(secret),
      };
    },

    /** Confirm setup by verifying a first code; marks the secret usable. */
    async confirm(userId: string, code: string, nowMs: number): Promise<TotpResult> {
      const repo = createTotpSecretsRepository(pool);
      const record = await repo.findByUserId(userId);
      if (!record) {
        return { ok: false, reason: 'no_totp' };
      }
      const result = verifyTotp(decryptSecret(record, userId), code, Math.floor(nowMs / 1000), config);
      if (!result.valid) {
        return { ok: false, reason: 'bad_code' };
      }
      if (record.lastUsedStep !== null && result.step <= record.lastUsedStep) {
        return { ok: false, reason: 'replay' };
      }
      // The atomic watermark advance is authoritative: if it did not advance, a
      // concurrent verify already consumed this step (replay).
      if (!(await repo.setLastUsedStep(userId, result.step))) {
        return { ok: false, reason: 'replay' };
      }
      await repo.markConfirmed(userId);
      return { ok: true };
    },

    /** Step-up verify: check a code against the CONFIRMED secret, replay-protected. */
    async verify(userId: string, code: string, nowMs: number): Promise<TotpResult> {
      const repo = createTotpSecretsRepository(pool);
      const record = await repo.findByUserId(userId);
      if (!record || !record.confirmed) {
        return { ok: false, reason: 'no_totp' };
      }
      const result = verifyTotp(decryptSecret(record, userId), code, Math.floor(nowMs / 1000), config);
      if (!result.valid) {
        return { ok: false, reason: 'bad_code' };
      }
      if (record.lastUsedStep !== null && result.step <= record.lastUsedStep) {
        return { ok: false, reason: 'replay' }; // a used code/counter cannot be reused
      }
      // Atomic advance is authoritative: a non-advance means a concurrent verify
      // already consumed this step ⇒ replay (closes the read-then-write race).
      if (!(await repo.setLastUsedStep(userId, result.step))) {
        return { ok: false, reason: 'replay' };
      }
      return { ok: true };
    },
  };
}

export type TotpService = ReturnType<typeof createTotpService>;
