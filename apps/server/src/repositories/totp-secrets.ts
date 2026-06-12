import type { Db } from './pool';

// TOTP secret persistence (ADR-0012). Stores the shared secret ENCRYPTED at rest
// (services/secretbox.ts, server-managed key) — never the plaintext secret, never
// the master password. `confirmed` gates step-up use until the user proves
// possession on setup; `last_used_step` is the replay watermark (a code at a step
// ≤ this cannot be reused). All access is by the authenticated user_id.

export interface TotpSecretRecord {
  secretEncrypted: Buffer;
  nonce: Buffer;
  confirmed: boolean;
  lastUsedStep: number | null;
}

export interface UpsertTotpInput {
  userId: string;
  secretEncrypted: Buffer;
  nonce: Buffer;
}

export function createTotpSecretsRepository(db: Db) {
  return {
    /** Store (or replace) the user's TOTP secret as UNCONFIRMED, resetting replay state. */
    async upsert(input: UpsertTotpInput): Promise<void> {
      await db.query(
        `INSERT INTO totp_secrets (user_id, secret_encrypted, nonce, confirmed, last_used_step)
         VALUES ($1, $2, $3, FALSE, NULL)
         ON CONFLICT (user_id) DO UPDATE SET
           secret_encrypted = EXCLUDED.secret_encrypted,
           nonce            = EXCLUDED.nonce,
           confirmed        = FALSE,
           last_used_step   = NULL`,
        [input.userId, input.secretEncrypted, input.nonce],
      );
    },

    async findByUserId(userId: string): Promise<TotpSecretRecord | null> {
      const result = await db.query<{
        secret_encrypted: Buffer;
        nonce: Buffer;
        confirmed: boolean;
        last_used_step: string | null;
      }>(
        `SELECT secret_encrypted, nonce, confirmed, last_used_step
         FROM totp_secrets WHERE user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      return row
        ? {
            secretEncrypted: row.secret_encrypted,
            nonce: row.nonce,
            confirmed: row.confirmed,
            lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step),
          }
        : null;
    },

    /** Whether the user has a CONFIRMED TOTP secret (a usable second factor). */
    async hasConfirmed(userId: string): Promise<boolean> {
      const result = await db.query<{ confirmed: boolean }>(
        `SELECT confirmed FROM totp_secrets WHERE user_id = $1`,
        [userId],
      );
      return result.rows[0]?.confirmed === true;
    },

    async markConfirmed(userId: string): Promise<void> {
      await db.query(`UPDATE totp_secrets SET confirmed = TRUE WHERE user_id = $1`, [userId]);
    },

    /**
     * Atomically advance the replay watermark (monotonic). Returns TRUE only if
     * THIS call advanced it — a FALSE means a concurrent verify already consumed
     * this (or a later) step, so the caller must treat its own attempt as a replay.
     * The conditional UPDATE is the single source of truth, closing the
     * read-then-write race (a transaction/lock is not needed for one statement).
     */
    async setLastUsedStep(userId: string, step: number): Promise<boolean> {
      const result = await db.query(
        `UPDATE totp_secrets SET last_used_step = $2
         WHERE user_id = $1 AND (last_used_step IS NULL OR last_used_step < $2)`,
        [userId, step],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export type TotpSecretsRepository = ReturnType<typeof createTotpSecretsRepository>;
