import type { Db } from './pool';

// Failed-login store feeding the failure-velocity signal (M8 / ADR-0011).
// Append-only; stores only an optional user_id and a TRUNCATED IP — never the
// attempted password or the full IP (PROJECT.md §5). user_id is NULL when the
// claimed username does not exist (enumeration-safe). Reads are windowed counts.

export interface RecordFailureInput {
  /** The resolved user id, or null if the username is unknown. */
  userId: string | null;
  /** Truncated client IP (coarsened), or null if unavailable. */
  ipTruncated: string | null;
}

export function createLoginFailuresRepository(db: Db) {
  return {
    /** Record one failed login attempt. */
    async record(input: RecordFailureInput): Promise<void> {
      await db.query(
        `INSERT INTO login_failures (user_id, ip_truncated) VALUES ($1, $2)`,
        [input.userId, input.ipTruncated],
      );
    },

    /** Count this account's failures since `since`. */
    async countRecentByUser(userId: string, since: Date): Promise<number> {
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM login_failures
         WHERE user_id = $1 AND occurred_at >= $2`,
        [userId, since],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /** Count failures from this truncated IP since `since`. */
    async countRecentByIp(ipTruncated: string, since: Date): Promise<number> {
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM login_failures
         WHERE ip_truncated = $1 AND occurred_at >= $2`,
        [ipTruncated, since],
      );
      return Number(result.rows[0]?.count ?? 0);
    },
  };
}

export type LoginFailuresRepository = ReturnType<typeof createLoginFailuresRepository>;
