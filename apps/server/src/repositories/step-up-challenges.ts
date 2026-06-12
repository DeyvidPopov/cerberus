import type { Db } from './pool';

// Step-up challenge persistence (ADR-0012). A step-up challenge is the short-lived,
// single-use authorization to issue a session once the second factor (TOTP) is
// satisfied — created when a login bands to step_up, after the password is already
// verified. The raw challenge handle is returned to the client; only its HASH is
// stored (like a session token). It carries the device the pending login is for so
// the session can be created on success. All access is by user_id / token hash.

export type ChallengeMethod = 'totp' | 'email_otp';
export type ChallengeStatus = 'pending' | 'passed' | 'failed' | 'expired';

export interface CreateChallengeInput {
  userId: string;
  tokenHash: string;
  deviceId: string | null;
  isNewDevice: boolean;
  method: ChallengeMethod;
  expiresAt: Date;
}

export interface ChallengeRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  isNewDevice: boolean;
  status: ChallengeStatus;
  expiresAt: Date;
}

export function createStepUpChallengesRepository(db: Db) {
  return {
    async create(input: CreateChallengeInput): Promise<{ id: string }> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO step_up_challenges
           (user_id, token_hash, device_id, is_new_device, method, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING id`,
        [input.userId, input.tokenHash, input.deviceId, input.isNewDevice, input.method, input.expiresAt],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('step_up_challenges insert returned no row');
      }
      return { id: row.id };
    },

    /** A still-pending, unexpired challenge by its token hash (scoped by the hash). */
    async findPendingByTokenHash(tokenHash: string): Promise<ChallengeRecord | null> {
      const result = await db.query<{
        id: string;
        user_id: string;
        device_id: string | null;
        is_new_device: boolean;
        status: ChallengeStatus;
        expires_at: Date;
      }>(
        `SELECT id, user_id, device_id, is_new_device, status, expires_at
         FROM step_up_challenges
         WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            userId: row.user_id,
            deviceId: row.device_id,
            isNewDevice: row.is_new_device,
            status: row.status,
            expiresAt: row.expires_at,
          }
        : null;
    },

    /**
     * Atomically consume a STILL-PENDING challenge (single-use). Returns TRUE only
     * if this call consumed it; FALSE means it was already resolved/expired (or a
     * concurrent verify won the race), so the caller must NOT issue a session.
     */
    async consume(id: string, status: 'passed' | 'failed'): Promise<boolean> {
      const result = await db.query(
        `UPDATE step_up_challenges SET status = $2, consumed_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [id, status],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export type StepUpChallengesRepository = ReturnType<typeof createStepUpChallengesRepository>;
