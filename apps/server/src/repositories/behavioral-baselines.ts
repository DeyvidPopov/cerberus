import type { Db } from './pool';

// Behavioral-baseline persistence (ADR-0002, ADR-0009, ADR-0013). Stores the fitted
// model ONLY (mean + covariance), encrypted at rest, pseudonymized by user_id. NO
// raw captures are ever stored here. Every method is scoped to (user_id, modality)
// (defense against IDOR). The encrypted model blob is biometric-adjacent, so it is
// NOT returned by the routine status path — only `findActiveByUser` (metadata) is;
// the blob is fetched separately (scoring / tests) via `findActiveModel`.
//
// One baseline per modality (ADR-0013): the SAME table/lifecycle holds both the
// keystroke and mouse baselines; `modality` discriminates them. It defaults to
// 'keystroke' so the M6/M7/M9 keystroke call sites are unchanged.

/** Behavioral modality (keystroke = login typing; mouse = in-session dynamics). */
export type Modality = 'keystroke' | 'mouse';

export interface BaselineMeta {
  id: string;
  featureSchemaVersion: number;
  modelVersion: number;
  sampleCount: number;
  status: 'enrolling' | 'active' | 'retired';
}

export interface ActivateBaselineInput {
  userId: string;
  modality: Modality;
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
    /** The user's active baseline metadata (no model blob) for a modality, or null. */
    async findActiveByUser(userId: string, modality: Modality = 'keystroke'): Promise<BaselineMeta | null> {
      const result = await db.query<MetaRow>(
        `SELECT id, feature_schema_version, model_version, sample_count, status
         FROM behavioral_baselines
         WHERE user_id = $1 AND modality = $2 AND status = 'active'`,
        [userId, modality],
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

    /** The user's active encrypted model blob for a modality (scoring / tests), or null. */
    async findActiveModel(userId: string, modality: Modality = 'keystroke'): Promise<EncryptedModel | null> {
      const result = await db.query<{
        model_blob_encrypted: Buffer;
        model_nonce: Buffer;
        feature_schema_version: number;
        model_version: number;
      }>(
        `SELECT model_blob_encrypted, model_nonce, feature_schema_version, model_version
         FROM behavioral_baselines
         WHERE user_id = $1 AND modality = $2 AND status = 'active'`,
        [userId, modality],
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
     * Upsert the user's baseline to ACTIVE with the freshly-fitted encrypted model.
     * Keyed by (user_id, modality, model_version) per the schema's unique constraint
     * (ADR-0013), so a mouse baseline never overwrites the keystroke one.
     */
    async activate(input: ActivateBaselineInput): Promise<void> {
      await db.query(
        `INSERT INTO behavioral_baselines
           (user_id, modality, feature_schema_version, model_version,
            model_blob_encrypted, model_nonce, sample_count, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now())
         ON CONFLICT (user_id, modality, model_version) DO UPDATE SET
           feature_schema_version = EXCLUDED.feature_schema_version,
           model_blob_encrypted   = EXCLUDED.model_blob_encrypted,
           model_nonce            = EXCLUDED.model_nonce,
           sample_count           = EXCLUDED.sample_count,
           status                 = 'active',
           updated_at             = now()`,
        [
          input.userId,
          input.modality,
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
