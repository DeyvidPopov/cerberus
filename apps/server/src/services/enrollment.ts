// Enrollment service (ADR-0002, ADR-0009, ADR-0013). The authoritative enrollment
// lifecycle: accumulate position-indexed samples → when enough are buffered, fit
// a baseline (mean + regularized covariance) → store it MODEL-ONLY and encrypted
// at rest → PURGE the raw samples → mark active. NO anomaly scoring (that is the
// scorer's job). MODALITY-AGNOSTIC: the SAME lifecycle fits the keystroke baseline
// (M6) and the mouse baseline (M10) — it is parameterized by modality + schema, not
// duplicated per modality (defaults keep the keystroke call sites unchanged).
//
// Privacy: feature vectors are biometric-adjacent. They are never logged; the
// fitted model is encrypted before storage; the raw buffer is deleted on
// activation (data minimization). The master password never reaches this path.
import {
  FEATURE_SCHEMA_VERSION,
  type EnrollmentSampleRequest,
  type EnrollmentStatus,
} from '@cerberus/shared-types';
import type { Pool } from 'pg';

import { withTransaction } from '../repositories/pool';
import { createBehavioralBaselinesRepository, type Modality } from '../repositories/behavioral-baselines';
import { createEnrollmentSamplesRepository } from '../repositories/enrollment-samples';
import { BASELINE_MODEL_VERSION } from '../risk/config';
import { fitBaseline, type FittedBaseline } from '../risk/baseline-model';
import { encryptBaselineModel } from './baseline-crypto';

export interface EnrollmentServiceDeps {
  pool: Pool;
  /** Server-managed at-rest key for the baseline model (separate from any vault key). */
  baselineEncryptionKey: Buffer;
  /** Samples required before the baseline activates (ADR-0002; config, no magic number). */
  minEnrollmentSamples: number;
  /** Which behavioral modality this instance enrolls (default keystroke). */
  modality?: Modality;
  /** Feature-schema version this instance accepts/stamps (default keystroke schema). */
  featureSchemaVersion?: number;
  /** Stored model version (default the keystroke baseline model version). */
  modelVersion?: number;
}

export type SubmitResult =
  | { ok: true; status: EnrollmentStatus }
  | { ok: false; reason: 'schema_version' | 'dimension_mismatch' };

/**
 * The fitted-model blob layout (encrypted before storage). MODEL ONLY: means +
 * covariance + the regularization metadata the scorer needs. NO raw samples.
 */
interface SerializedModel {
  featureSchemaVersion: number;
  modelVersion: number;
  dimension: number;
  sampleCount: number;
  mean: number[];
  covariance: number[][];
  shrinkage: number;
  ridge: number;
}

export function createEnrollmentService(deps: EnrollmentServiceDeps) {
  const { pool, baselineEncryptionKey, minEnrollmentSamples } = deps;
  const modality = deps.modality ?? 'keystroke';
  const featureSchemaVersion = deps.featureSchemaVersion ?? FEATURE_SCHEMA_VERSION;
  const modelVersion = deps.modelVersion ?? BASELINE_MODEL_VERSION;

  function serializeModel(fitted: FittedBaseline): Buffer {
    const model: SerializedModel = {
      featureSchemaVersion,
      modelVersion,
      dimension: fitted.dimension,
      sampleCount: fitted.sampleCount,
      mean: fitted.mean,
      covariance: fitted.covariance,
      shrinkage: fitted.shrinkage,
      ridge: fitted.ridge,
    };
    return Buffer.from(JSON.stringify(model), 'utf8');
  }

  function activeStatus(sampleCount: number): EnrollmentStatus {
    return {
      status: 'active',
      samplesCollected: sampleCount,
      samplesRequired: minEnrollmentSamples,
      featureSchemaVersion,
    };
  }

  function enrollingStatus(collected: number): EnrollmentStatus {
    return {
      status: 'enrolling',
      samplesCollected: collected,
      samplesRequired: minEnrollmentSamples,
      featureSchemaVersion,
    };
  }

  return {
    /** Enrollment progress for the user (active, or N collected of M required). */
    async getStatus(userId: string): Promise<EnrollmentStatus> {
      const active = await createBehavioralBaselinesRepository(pool).findActiveByUser(userId, modality);
      if (active) {
        return activeStatus(active.sampleCount);
      }
      const collected = await createEnrollmentSamplesRepository(pool).countByUser(userId, modality);
      return enrollingStatus(collected);
    },

    /**
     * Discard the user's buffered enrollment samples and start over (e.g. the user
     * realised they pasted / mistyped during onboarding). Only clears the in-progress
     * buffer — an already-ACTIVE baseline is left intact (the rhythm step isn't shown
     * once it's active). Scoped to the caller's own user. Returns the fresh status.
     */
    async reset(userId: string): Promise<EnrollmentStatus> {
      await createEnrollmentSamplesRepository(pool).deleteByUser(userId, modality);
      return enrollingStatus(0);
    },

    /**
     * Accept one enrollment sample. Once the buffer reaches the threshold, fit
     * and activate the baseline and purge the buffer — all inside one
     * per-(user,modality)-serialized transaction so the fit/store/purge is atomic
     * and two concurrent submits cannot double-fit.
     */
    async submitSample(userId: string, input: EnrollmentSampleRequest): Promise<SubmitResult> {
      if (input.featureSchemaVersion !== featureSchemaVersion) {
        return { ok: false, reason: 'schema_version' };
      }

      return withTransaction(pool, async (tx) => {
        // Serialize this user's enrollment writes for THIS modality against each
        // other (keystroke and mouse enrollment do not block one another).
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${userId}:${modality}`]);

        const baselines = createBehavioralBaselinesRepository(tx);
        const samples = createEnrollmentSamplesRepository(tx);

        const active = await baselines.findActiveByUser(userId, modality);
        if (active) {
          // Already enrolled — idempotent: do not buffer more raw samples.
          return { ok: true, status: activeStatus(active.sampleCount) };
        }

        const pendingDim = await samples.pendingDimension(userId, modality);
        if (pendingDim !== null && pendingDim !== input.features.length) {
          // Vector dimension changed mid-enrollment; reject so the client resets.
          return { ok: false, reason: 'dimension_mismatch' };
        }

        await samples.create({
          userId,
          modality,
          featureSchemaVersion: input.featureSchemaVersion,
          featureVector: input.features,
        });

        const count = await samples.countByUser(userId, modality);
        if (count < minEnrollmentSamples) {
          return { ok: true, status: enrollingStatus(count) };
        }

        // Threshold reached: fit → encrypt → activate → purge (atomic).
        const vectors = await samples.listVectorsByUser(userId, modality);
        const fitted = fitBaseline(vectors);
        const blob = encryptBaselineModel(serializeModel(fitted), userId, baselineEncryptionKey);
        await baselines.activate({
          userId,
          modality,
          featureSchemaVersion,
          modelVersion,
          modelBlob: blob.ciphertext,
          modelNonce: blob.nonce,
          sampleCount: count,
        });
        await samples.deleteByUser(userId, modality); // data minimization (ADR-0002)

        return { ok: true, status: activeStatus(count) };
      });
    },
  };
}

export type EnrollmentService = ReturnType<typeof createEnrollmentService>;
