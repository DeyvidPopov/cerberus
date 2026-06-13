import type { Modality } from './behavioral-baselines';
import type { Db } from './pool';

// Ephemeral enrollment-sample buffer (ADR-0002, ADR-0009, ADR-0013). Holds
// position-indexed feature vectors (durations/geometry only — never characters or
// pointer content) until a baseline is fitted, then PURGED. EVERY method is scoped
// to (user_id, modality) in its WHERE clause — authorization is enforced here, in
// the repository (defense against IDOR). `modality` defaults to 'keystroke' so the
// M6 keystroke call sites are unchanged; mouse buffers under its own modality.
//
// `feature_vector` is jsonb; node-pg parses it back to a JS number[]. We pass it
// as a parameterized jsonb literal — never string-concatenated SQL.

export interface CreateEnrollmentSampleInput {
  userId: string;
  modality?: Modality;
  featureSchemaVersion: number;
  featureVector: number[];
}

export function createEnrollmentSamplesRepository(db: Db) {
  return {
    /** Append one sample to the user's enrollment buffer for its modality. */
    async create(input: CreateEnrollmentSampleInput): Promise<void> {
      await db.query(
        `INSERT INTO enrollment_samples (user_id, modality, feature_schema_version, feature_vector)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          input.userId,
          input.modality ?? 'keystroke',
          input.featureSchemaVersion,
          JSON.stringify(input.featureVector),
        ],
      );
    },

    /** Count the user's buffered samples for a modality. */
    async countByUser(userId: string, modality: Modality = 'keystroke'): Promise<number> {
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM enrollment_samples WHERE user_id = $1 AND modality = $2`,
        [userId, modality],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /**
     * The dimension of the user's buffered vectors (length of the most recent),
     * or null if none. Used to reject a sample whose dimension changed mid-enrollment.
     */
    async pendingDimension(userId: string, modality: Modality = 'keystroke'): Promise<number | null> {
      const result = await db.query<{ dim: number | null }>(
        `SELECT jsonb_array_length(feature_vector) AS dim
         FROM enrollment_samples
         WHERE user_id = $1 AND modality = $2
         ORDER BY captured_at DESC
         LIMIT 1`,
        [userId, modality],
      );
      const dim = result.rows[0]?.dim;
      return dim === undefined || dim === null ? null : Number(dim);
    },

    /** All buffered feature vectors for the user + modality, oldest first (for fitting). */
    async listVectorsByUser(userId: string, modality: Modality = 'keystroke'): Promise<number[][]> {
      const result = await db.query<{ feature_vector: number[] }>(
        `SELECT feature_vector
         FROM enrollment_samples
         WHERE user_id = $1 AND modality = $2
         ORDER BY captured_at`,
        [userId, modality],
      );
      return result.rows.map((r) => r.feature_vector);
    },

    /** Purge the user's enrollment buffer for a modality (data minimization). Returns rows removed. */
    async deleteByUser(userId: string, modality: Modality = 'keystroke'): Promise<number> {
      const result = await db.query(
        `DELETE FROM enrollment_samples WHERE user_id = $1 AND modality = $2`,
        [userId, modality],
      );
      return result.rowCount ?? 0;
    },
  };
}

export type EnrollmentSamplesRepository = ReturnType<typeof createEnrollmentSamplesRepository>;
