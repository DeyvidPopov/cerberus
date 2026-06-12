// Behavioral facade (ADR-0009 enrollment + ADR-0010 scoring + ADR-0011 context).
//
// One post-login keystroke submission is the per-login risk-evaluation point. On
// every submission the facade:
//   1. evaluates the four CONTEXTUAL signals (always — even while enrolling), and
//   2. dispatches the BEHAVIORAL leg by baseline state: active → score; else buffer,
// then writes ONE risk_events row aggregating all signals. The composite/context
// score and policy band are left NULL (M9 owns the combiner). Nothing is enforced
// and the score is never returned to the client.
import { FEATURE_SCHEMA_VERSION, type EnrollmentSampleRequest, type EnrollmentStatus } from '@cerberus/shared-types';
import type { Pool } from 'pg';

import { createBehavioralBaselinesRepository } from '../repositories/behavioral-baselines';
import { createRiskEventsRepository } from '../repositories/risk-events';
import type { ContextualConfig } from '../risk/config';
import { createContextualRiskService, type ContextualEvaluation } from './contextual-risk';
import { createEnrollmentService, type SubmitResult } from './enrollment';
import type { GeoLookup } from './geoip';
import { createScoringService } from './scoring';

export interface BehavioralServiceDeps {
  pool: Pool;
  baselineEncryptionKey: Buffer;
  minEnrollmentSamples: number;
  geoLookup: GeoLookup;
  contextualConfig: ContextualConfig;
}

/** Per-request login context the contextual signals need. */
export interface SubmitContext {
  userId: string;
  deviceId: string | null;
  isNewDevice: boolean;
  sessionCreatedAt: Date;
  ip: string | null;
  now: Date;
}

export function createBehavioralService(deps: BehavioralServiceDeps) {
  const { pool, minEnrollmentSamples } = deps;
  const enrollment = createEnrollmentService(deps);
  const scoring = createScoringService({ pool, baselineEncryptionKey: deps.baselineEncryptionKey });
  const contextual = createContextualRiskService({
    pool,
    geoLookup: deps.geoLookup,
    config: deps.contextualConfig,
  });

  function activeStatus(sampleCount: number): EnrollmentStatus {
    return {
      status: 'active',
      samplesCollected: sampleCount,
      samplesRequired: minEnrollmentSamples,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    };
  }

  async function writeRow(
    ctx: SubmitContext,
    context: ContextualEvaluation,
    behavioral: { behavioralScore: number | null; keystroke: Record<string, unknown>; outcome: string },
  ): Promise<void> {
    await createRiskEventsRepository(pool).insert({
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      // One row, all signals. composite/context/band/action left NULL (M9).
      signals: { keystroke: behavioral.keystroke, ...context.signals },
      behavioralScore: behavioral.behavioralScore,
      geoCountry: context.geoCountry,
      geoRegion: context.geoRegion,
      ipTruncated: context.ipTruncated,
      outcome: behavioral.outcome,
    });
  }

  return {
    /** Enrollment progress for the user (delegated to the M6 enrollment service). */
    getStatus: enrollment.getStatus,

    /**
     * Handle one post-login keystroke sample: evaluate contextual signals, dispatch
     * the behavioral leg, and log one combined risk_events row. Returns the
     * enrollment status (the score is not exposed over the API).
     */
    async submitSample(ctx: SubmitContext, input: EnrollmentSampleRequest): Promise<SubmitResult> {
      const context = await contextual.evaluate({
        userId: ctx.userId,
        deviceId: ctx.deviceId,
        isNewDevice: ctx.isNewDevice,
        sessionCreatedAt: ctx.sessionCreatedAt,
        ip: ctx.ip,
        now: ctx.now,
      });

      const active = await createBehavioralBaselinesRepository(pool).findActiveByUser(ctx.userId);
      if (active) {
        const behavioral = await scoring.scoreActive(ctx.userId, input);
        await writeRow(ctx, context, behavioral);
        return { ok: true, status: activeStatus(active.sampleCount) };
      }

      // Enrolling: buffer the sample (M6). Still log the contextual row.
      const result = await enrollment.submitSample(ctx.userId, input);
      const outcome = result.ok ? 'enrolling' : `enroll_rejected:${result.reason}`;
      const reason = result.ok ? { status: 'enrolling' } : { status: 'enrolling', cause: result.reason };
      await writeRow(ctx, context, {
        behavioralScore: null,
        keystroke: { score: null, reason },
        outcome,
      });
      return result;
    },
  };
}

export type BehavioralService = ReturnType<typeof createBehavioralService>;
