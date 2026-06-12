// Behavioral facade (ADR-0009 enrollment + ADR-0010 scoring). One post-login
// keystroke submission, dispatched by baseline state:
//   - ACTIVE baseline  → SCORE the sample and log a risk_event (M7), return active.
//   - else (enrolling) → BUFFER the sample toward a baseline (M6).
// The client posts to a single endpoint and is unchanged; the server decides.
// The score is never returned to the client and never enforced (logged only).
import { FEATURE_SCHEMA_VERSION, type EnrollmentSampleRequest, type EnrollmentStatus } from '@cerberus/shared-types';
import type { Pool } from 'pg';

import { createBehavioralBaselinesRepository } from '../repositories/behavioral-baselines';
import { createEnrollmentService, type SubmitResult } from './enrollment';
import { createScoringService } from './scoring';

export interface BehavioralServiceDeps {
  pool: Pool;
  baselineEncryptionKey: Buffer;
  minEnrollmentSamples: number;
}

export function createBehavioralService(deps: BehavioralServiceDeps) {
  const { pool, minEnrollmentSamples } = deps;
  const enrollment = createEnrollmentService(deps);
  const scoring = createScoringService({ pool, baselineEncryptionKey: deps.baselineEncryptionKey });

  function activeStatus(sampleCount: number): EnrollmentStatus {
    return {
      status: 'active',
      samplesCollected: sampleCount,
      samplesRequired: minEnrollmentSamples,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    };
  }

  return {
    /** Enrollment progress for the user (delegated to the M6 enrollment service). */
    getStatus: enrollment.getStatus,

    /**
     * Handle one post-login keystroke sample. With an active baseline the sample
     * is scored and logged (M7, not enforced); otherwise it is buffered toward the
     * baseline (M6). The response is always the enrollment status — the score is
     * not exposed over the API.
     */
    async submitSample(
      userId: string,
      deviceId: string | null,
      input: EnrollmentSampleRequest,
    ): Promise<SubmitResult> {
      const active = await createBehavioralBaselinesRepository(pool).findActiveByUser(userId);
      if (active) {
        await scoring.scoreLogin(userId, deviceId, input); // logs risk_event; never enforces
        return { ok: true, status: activeStatus(active.sampleCount) };
      }
      return enrollment.submitSample(userId, input);
    },
  };
}

export type BehavioralService = ReturnType<typeof createBehavioralService>;
