// Enrollment service (ADR-0002, ADR-0009). The authoritative enrollment
// lifecycle: accumulate position-indexed samples → when enough are buffered, fit
// a baseline (mean + regularized covariance) → store it MODEL-ONLY and encrypted
// at rest → PURGE the raw samples → mark active. NO anomaly scoring (that is M7).
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
import { createBehavioralBaselinesRepository } from '../repositories/behavioral-baselines';
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
}

export type SubmitResult =
  | { ok: true; status: EnrollmentStatus }
  | { ok: false; reason: 'schema_version' | 'dimension_mismatch' };

/**
 * The fitted-model blob layout (encrypted before storage). MODEL ONLY: means +
 * covariance + the regularization metadata M7 needs. NO raw samples are present.
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

function serializeModel(fitted: FittedBaseline): Buffer {
  const model: SerializedModel = {
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    modelVersion: BASELINE_MODEL_VERSION,
    dimension: fitted.dimension,
    sampleCount: fitted.sampleCount,
    mean: fitted.mean,
    covariance: fitted.covariance,
    shrinkage: fitted.shrinkage,
    ridge: fitted.ridge,
  };
  return Buffer.from(JSON.stringify(model), 'utf8');
}

export function createEnrollmentService(deps: EnrollmentServiceDeps) {
  const { pool, baselineEncryptionKey, minEnrollmentSamples } = deps;

  function activeStatus(sampleCount: number): EnrollmentStatus {
    return {
      status: 'active',
      samplesCollected: sampleCount,
      samplesRequired: minEnrollmentSamples,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    };
  }

  function enrollingStatus(collected: number): EnrollmentStatus {
    return {
      status: 'enrolling',
      samplesCollected: collected,
      samplesRequired: minEnrollmentSamples,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    };
  }

  return {
    /** Enrollment progress for the user (active, or N collected of M required). */
    async getStatus(userId: string): Promise<EnrollmentStatus> {
      const active = await createBehavioralBaselinesRepository(pool).findActiveByUser(userId);
      if (active) {
        return activeStatus(active.sampleCount);
      }
      const collected = await createEnrollmentSamplesRepository(pool).countByUser(userId);
      return enrollingStatus(collected);
    },

    /**
     * Accept one enrollment sample. Once the buffer reaches the threshold, fit
     * and activate the baseline and purge the buffer — all inside one
     * per-user-serialized transaction so the fit/store/purge is atomic and two
     * concurrent submits cannot double-fit.
     */
    async submitSample(userId: string, input: EnrollmentSampleRequest): Promise<SubmitResult> {
      if (input.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
        return { ok: false, reason: 'schema_version' };
      }

      return withTransaction(pool, async (tx) => {
        // Serialize all of a user's enrollment writes against each other.
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);

        const baselines = createBehavioralBaselinesRepository(tx);
        const samples = createEnrollmentSamplesRepository(tx);

        const active = await baselines.findActiveByUser(userId);
        if (active) {
          // Already enrolled — idempotent: do not buffer more raw samples.
          return { ok: true, status: activeStatus(active.sampleCount) };
        }

        const pendingDim = await samples.pendingDimension(userId);
        if (pendingDim !== null && pendingDim !== input.features.length) {
          // Password length changed mid-enrollment; reject so the client resets.
          return { ok: false, reason: 'dimension_mismatch' };
        }

        await samples.create({
          userId,
          featureSchemaVersion: input.featureSchemaVersion,
          featureVector: input.features,
        });

        const count = await samples.countByUser(userId);
        if (count < minEnrollmentSamples) {
          return { ok: true, status: enrollingStatus(count) };
        }

        // Threshold reached: fit → encrypt → activate → purge (atomic).
        const vectors = await samples.listVectorsByUser(userId);
        const fitted = fitBaseline(vectors);
        const blob = encryptBaselineModel(serializeModel(fitted), userId, baselineEncryptionKey);
        await baselines.activate({
          userId,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          modelVersion: BASELINE_MODEL_VERSION,
          modelBlob: blob.ciphertext,
          modelNonce: blob.nonce,
          sampleCount: count,
        });
        await samples.deleteByUser(userId); // data minimization (ADR-0002)

        return { ok: true, status: activeStatus(count) };
      });
    },
  };
}

export type EnrollmentService = ReturnType<typeof createEnrollmentService>;
