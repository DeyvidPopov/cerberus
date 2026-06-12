import type { Db } from './pool';

// Behavioral-baseline persistence (ADR-0002, ADR-0009). Stores the fitted model
// ONLY (mean + covariance), encrypted at rest, pseudonymized by user_id. NO raw
// keystroke captures are ever stored here. Every method is scoped to user_id
// (defense against IDOR). The encrypted model blob is biometric-adjacent, so it
// is NOT returned by the routine status path — only `findActiveByUser` (metadata)
// is; the blob is fetched separately (M7 scoring / tests) via `findActiveModel`.

export interface BaselineMeta {
  id: string;
  featureSchemaVersion: number;
  modelVersion: number;
  sampleCount: number;
  status: 'enrolling' | 'active' | 'retired';
}

export interface ActivateBaselineInput {
  userId: string;
  featureSchemaVersion: number;
  modelVersion: number;
  modelBlob: Buffer;
  modelNonce: Buffer;
  sampleCount: number;
}

export interface EncryptedModel {
  modelBlob: Buffer;
  modelNonce: Buffer;
  featureSchemaVersion: number;
  modelVersion: number;
}

interface MetaRow {
  id: string;
  feature_schema_version: number;
  model_version: number;
  sample_count: number;
  status: 'enrolling' | 'active' | 'retired';
}

export function createBehavioralBaselinesRepository(db: Db) {
  return {
    /** The user's active baseline metadata (no model blob), or null. */
    async findActiveByUser(userId: string): Promise<BaselineMeta | null> {
      const result = await db.query<MetaRow>(
        `SELECT id, feature_schema_version, model_version, sample_count, status
         FROM behavioral_baselines
         WHERE user_id = $1 AND status = 'active'`,
        [userId],
      );
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            featureSchemaVersion: row.feature_schema_version,
            modelVersion: row.model_version,
            sampleCount: row.sample_count,
            status: row.status,
          }
        : null;
    },

    /** The user's active encrypted model blob (M7 scoring / tests), or null. */
    async findActiveModel(userId: string): Promise<EncryptedModel | null> {
      const result = await db.query<{
        model_blob_encrypted: Buffer;
        model_nonce: Buffer;
        feature_schema_version: number;
        model_version: number;
      }>(
        `SELECT model_blob_encrypted, model_nonce, feature_schema_version, model_version
         FROM behavioral_baselines
         WHERE user_id = $1 AND status = 'active'`,
        [userId],
      );
      const row = result.rows[0];
      return row
        ? {
            modelBlob: row.model_blob_encrypted,
            modelNonce: row.model_nonce,
            featureSchemaVersion: row.feature_schema_version,
            modelVersion: row.model_version,
          }
        : null;
    },

    /**
     * Upsert the user's baseline to ACTIVE with the freshly-fitted encrypted
     * model. Keyed by (user_id, model_version) per the schema's unique constraint.
     */
    async activate(input: ActivateBaselineInput): Promise<void> {
      await db.query(
        `INSERT INTO behavioral_baselines
           (user_id, feature_schema_version, model_version,
            model_blob_encrypted, model_nonce, sample_count, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', now())
         ON CONFLICT (user_id, model_version) DO UPDATE SET
           feature_schema_version = EXCLUDED.feature_schema_version,
           model_blob_encrypted   = EXCLUDED.model_blob_encrypted,
           model_nonce            = EXCLUDED.model_nonce,
           sample_count           = EXCLUDED.sample_count,
           status                 = 'active',
           updated_at             = now()`,
        [
          input.userId,
          input.featureSchemaVersion,
          input.modelVersion,
          input.modelBlob,
          input.modelNonce,
          input.sampleCount,
        ],
      );
    },
  };
}

export type BehavioralBaselinesRepository = ReturnType<typeof createBehavioralBaselinesRepository>;
