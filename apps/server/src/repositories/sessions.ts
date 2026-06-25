import type { Db } from './pool';

export interface CreateSessionInput {
  userId: string;
  deviceId: string | null;
  /** SHA-256 hash of the opaque session token. The raw token is never stored. */
  tokenHash: string;
  expiresAt: Date;
  /** Was the device new at this login (from enrollment)? Authoritative for new-device. */
  isNewDevice: boolean;
  /** Was this session issued via a PASSED step-up (TOTP) in this login? Default false. */
  stepUpConfirmed?: boolean;
}

export interface SessionRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  isNewDevice: boolean;
  /** True only if this session passed a step-up (TOTP) this session (gates /risk/events). */
  stepUpConfirmed: boolean;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  status: string;
  expires_at: Date;
  created_at: Date;
  is_new_device: boolean;
  step_up_confirmed: boolean;
}

export function createSessionsRepository(db: Db) {
  return {
    async create(input: CreateSessionInput): Promise<{ id: string }> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO sessions (user_id, device_id, token_hash, expires_at, is_new_device, step_up_confirmed)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          input.userId,
          input.deviceId,
          input.tokenHash,
          input.expiresAt,
          input.isNewDevice,
          input.stepUpConfirmed ?? false,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('session insert returned no row');
      }
      return { id: row.id };
    },

    /**
     * Lock an active session (continuous-auth spike → fail closed, ADR-0013). After
     * this the bearer token no longer authenticates (`findActiveByTokenHash` filters
     * status='active'), so all vault ops require a fresh re-unlock. Returns whether a
     * row transitioned (idempotent: a second lock is a no-op).
     */
    async markLocked(sessionId: string): Promise<boolean> {
      const result = await db.query(
        `UPDATE sessions SET status = 'locked' WHERE id = $1 AND status = 'active'`,
        [sessionId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    /**
     * Mark an active session as step-up-confirmed IN PLACE (a voluntary TOTP step-up
     * after a granted login — ADR-0012). Gates /risk/events + the live score stream.
     * Only touches an 'active' session (a locked/expired one cannot be elevated);
     * returns whether a row transitioned (idempotent).
     */
    async markStepUpConfirmed(sessionId: string): Promise<boolean> {
      const result = await db.query(
        `UPDATE sessions SET step_up_confirmed = TRUE WHERE id = $1 AND status = 'active'`,
        [sessionId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    /** Look up an active, unexpired session by its token hash. */
    async findActiveByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
      const result = await db.query<SessionRow>(
        `SELECT id, user_id, device_id, status, expires_at, created_at, is_new_device, step_up_confirmed
         FROM sessions
         WHERE token_hash = $1 AND status = 'active' AND expires_at > now()`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        userId: row.user_id,
        deviceId: row.device_id,
        status: row.status,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        isNewDevice: row.is_new_device,
        stepUpConfirmed: row.step_up_confirmed,
      };
    },

    /**
     * Hours-of-day (UTC, 0..23) of the user's prior logins created strictly before
     * `before` (so the current login is excluded), newest first, capped at `limit`.
     * Feeds the time-of-day signal. UTC keeps the hour consistent with the live
     * `Date.getUTCHours()` used at evaluation time.
     */
    async recentLoginHours(userId: string, before: Date, limit: number): Promise<number[]> {
      const result = await db.query<{ hour: number }>(
        `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour
         FROM sessions
         WHERE user_id = $1 AND created_at < $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [userId, before, limit],
      );
      return result.rows.map((r) => Number(r.hour));
    },
  };
}

export type SessionsRepository = ReturnType<typeof createSessionsRepository>;
