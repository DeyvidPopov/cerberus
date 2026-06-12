import type { Db } from './pool';

export interface CreateSessionInput {
  userId: string;
  deviceId: string | null;
  /** SHA-256 hash of the opaque session token. The raw token is never stored. */
  tokenHash: string;
  expiresAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  status: string;
  expiresAt: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  status: string;
  expires_at: Date;
}

export function createSessionsRepository(db: Db) {
  return {
    async create(input: CreateSessionInput): Promise<{ id: string }> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO sessions (user_id, device_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [input.userId, input.deviceId, input.tokenHash, input.expiresAt],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('session insert returned no row');
      }
      return { id: row.id };
    },

    /** Look up an active, unexpired session by its token hash. */
    async findActiveByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
      const result = await db.query<SessionRow>(
        `SELECT id, user_id, device_id, status, expires_at
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
      };
    },
  };
}

export type SessionsRepository = ReturnType<typeof createSessionsRepository>;
