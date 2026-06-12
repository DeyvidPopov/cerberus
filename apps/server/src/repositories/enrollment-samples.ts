import type { Db } from './pool';

// Ephemeral enrollment-sample buffer (ADR-0002, ADR-0009). Holds position-indexed
// feature vectors (durations only — never characters) until a baseline is fitted,
// then PURGED. EVERY method is scoped to user_id in its WHERE clause —
// authorization is enforced here, in the repository (defense against IDOR).
//
// `feature_vector` is jsonb; node-pg parses it back to a JS number[]. We pass it
// as a parameterized jsonb literal — never string-concatenated SQL.

export interface CreateEnrollmentSampleInput {
  userId: string;
  featureSchemaVersion: number;
  featureVector: number[];
}

export function createEnrollmentSamplesRepository(db: Db) {
  return {
    /** Append one sample to the user's enrollment buffer. */
    async create(input: CreateEnrollmentSampleInput): Promise<void> {
      await db.query(
        `INSERT INTO enrollment_samples (user_id, feature_schema_version, feature_vector)
         VALUES ($1, $2, $3::jsonb)`,
        [input.userId, input.featureSchemaVersion, JSON.stringify(input.featureVector)],
      );
    },

    /** Count the user's buffered samples. */
    async countByUser(userId: string): Promise<number> {
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM enrollment_samples WHERE user_id = $1`,
        [userId],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /**
     * The dimension of the user's buffered vectors (length of the most recent),
     * or null if none. Used to reject a sample whose dimension changed mid-enrollment.
     */
    async pendingDimension(userId: string): Promise<number | null> {
      const result = await db.query<{ dim: number | null }>(
        `SELECT jsonb_array_length(feature_vector) AS dim
         FROM enrollment_samples
         WHERE user_id = $1
         ORDER BY captured_at DESC
         LIMIT 1`,
        [userId],
      );
      const dim = result.rows[0]?.dim;
      return dim === undefined || dim === null ? null : Number(dim);
    },

    /** All buffered feature vectors for the user, oldest first (for fitting). */
    async listVectorsByUser(userId: string): Promise<number[][]> {
      const result = await db.query<{ feature_vector: number[] }>(
        `SELECT feature_vector
         FROM enrollment_samples
         WHERE user_id = $1
         ORDER BY captured_at`,
        [userId],
      );
      return result.rows.map((r) => r.feature_vector);
    },

    /** Purge the user's enrollment buffer (data minimization on activation). Returns rows removed. */
    async deleteByUser(userId: string): Promise<number> {
      const result = await db.query(`DELETE FROM enrollment_samples WHERE user_id = $1`, [userId]);
      return result.rowCount ?? 0;
    },
  };
}

export type EnrollmentSamplesRepository = ReturnType<typeof createEnrollmentSamplesRepository>;
