// Continuous-authentication service (M10 / ADR-0013). The in-session counterpart of
// the login risk decision, for the MOUSE modality. It is deliberately built from
// REUSED machinery (no per-modality duplication):
//   - the M6 enrollment lifecycle (accumulate windows → fit model-only baseline →
//     encrypt → purge → activate), parameterized for the mouse modality;
//   - the M7 Mahalanobis→χ² scorer, which is modality-agnostic;
//   - the in-session composite (EWMA) + spike band (risk/continuous-auth).
//
// Per window, dispatched by baseline state (mirrors the M8/M9 cold-start rule):
//   - NO active mouse baseline  → BUFFER the window toward the baseline; NEUTRAL
//     (cold-start, never a spurious lock);
//   - ACTIVE mouse baseline     → SCORE the window, fold it into the EWMA composite,
//     and signal a spike when the composite crosses the threshold (→ lock).
//
// PRIVACY (PROJECT.md §5): the raw window vector is never persisted beside identity;
// only the score + a scalar reason cross into the (server-side) decision record.
import {
  MOUSE_FEATURE_SCHEMA_VERSION,
  type MouseWindowMessage,
} from '@cerberus/shared-types';
import type { Pool } from 'pg';

import { createBehavioralBaselinesRepository } from '../repositories/behavioral-baselines';
import { isSpike, updateInSessionComposite } from '../risk/continuous-auth';
import { MOUSE_BASELINE_MODEL_VERSION, type ContinuousAuthConfig } from '../risk/config';
import { createEnrollmentService } from './enrollment';
import { createScoringService } from './scoring';

export interface ContinuousAuthDeps {
  pool: Pool;
  baselineEncryptionKey: Buffer;
  config: ContinuousAuthConfig;
}

/** The result of scoring one in-session window. */
export interface WindowEvaluation {
  /** True only when scored against an ACTIVE baseline (false = cold-start/enrolling). */
  scored: boolean;
  /** True when the in-session composite crossed the spike threshold → LOCK. */
  spike: boolean;
  /** Mouse sub-score ∈ [0,1] for this window, or null when not scored. */
  subScore: number | null;
  /** The running in-session composite (EWMA) after this window. */
  composite: number;
  /** Structured, explainable reason (score/distance metadata — NEVER the raw vector). */
  reason: Record<string, unknown>;
}

/** A per-connection evaluator holding the running composite for one open session. */
export interface SessionEvaluator {
  readonly composite: number;
  evaluate(userId: string, window: MouseWindowMessage): Promise<WindowEvaluation>;
}

export function createContinuousAuthService(deps: ContinuousAuthDeps) {
  const { pool, baselineEncryptionKey, config } = deps;

  // Mouse modality reuses the lifecycle + scorer, parameterized — not duplicated.
  const mouseEnrollment = createEnrollmentService({
    pool,
    baselineEncryptionKey,
    minEnrollmentSamples: config.minEnrollmentSamples,
    modality: 'mouse',
    featureSchemaVersion: MOUSE_FEATURE_SCHEMA_VERSION,
    modelVersion: MOUSE_BASELINE_MODEL_VERSION,
  });
  const mouseScoring = createScoringService({ pool, baselineEncryptionKey, modality: 'mouse' });

  return {
    /** Start a per-connection evaluator (its own EWMA composite, starting neutral). */
    newSession(): SessionEvaluator {
      let composite = 0;
      return {
        get composite(): number {
          return composite;
        },
        async evaluate(userId: string, window: MouseWindowMessage): Promise<WindowEvaluation> {
          const sample = {
            featureSchemaVersion: window.featureSchemaVersion,
            features: window.features,
          };
          const active = await createBehavioralBaselinesRepository(pool).findActiveByUser(userId, 'mouse');
          if (!active) {
            // Cold-start: buffer the window toward the mouse baseline; never lock.
            await mouseEnrollment.submitSample(userId, sample);
            return { scored: false, spike: false, subScore: null, composite, reason: { status: 'enrolling' } };
          }

          const result = await mouseScoring.scoreActive(userId, sample);
          if (result.outcome !== 'scored' || result.behavioralScore === null) {
            // Active baseline but the window did not score (e.g. dimension/schema
            // mismatch). Leave the composite untouched and do NOT lock on a single
            // malformed window; the next valid window resumes scoring.
            return {
              scored: false,
              spike: false,
              subScore: null,
              composite,
              reason: (result.keystroke.reason ?? {}) as Record<string, unknown>,
            };
          }

          composite = updateInSessionComposite(composite, result.behavioralScore, config.ewmaAlpha);
          return {
            scored: true,
            spike: isSpike(composite, config),
            subScore: result.behavioralScore,
            composite,
            reason: (result.keystroke.reason ?? {}) as Record<string, unknown>,
          };
        },
      };
    },
  };
}

export type ContinuousAuthService = ReturnType<typeof createContinuousAuthService>;
