// Behavioral scoring service (ADR-0002, ADR-0010). Loads a user's ACTIVE baseline
// (decrypts the model-only blob), scores a fresh post-login keystroke vector with
// Mahalanobis → chi-squared, and LOGS the result to risk_events.
//
// HARD CONSTRAINT (M7): the score is LOGGED, NEVER ENFORCED. Every event is
// written with policy_band = 'grant' and action_taken = 'observed' — no step-up,
// no deny. Real policy banding is M9.
//
// PRIVACY (PROJECT.md §5): the raw feature vector is biometric-adjacent and is
// NEVER written to risk_events — only the score + a structured reason (distance,
// dof, p-value, model metadata) are persisted.
import type { Pool } from 'pg';

import { createBehavioralBaselinesRepository } from '../repositories/behavioral-baselines';
import { createRiskEventsRepository } from '../repositories/risk-events';
import { BaselineModelSchema, scoreSample, type BaselineModel, type SampleToScore } from '../risk/scorer';
import { decryptBaselineModel } from './baseline-crypto';

// Observational logging constants (M7 does not enforce; PROJECT.md §4.4).
const OBSERVED_POLICY_BAND = 'grant' as const;
const OBSERVED_ACTION = 'observed';

export interface ScoringServiceDeps {
  pool: Pool;
  baselineEncryptionKey: Buffer;
}

export type ScoreOutcome =
  | { scored: true; score: number }
  | { scored: false; reason: 'no_active_baseline' | 'dimension_mismatch' | 'schema_version_mismatch' | 'singular_covariance' };

export function createScoringService(deps: ScoringServiceDeps) {
  const { pool, baselineEncryptionKey } = deps;

  async function loadActiveModel(userId: string): Promise<BaselineModel | null> {
    const encrypted = await createBehavioralBaselinesRepository(pool).findActiveModel(userId);
    if (!encrypted) {
      return null;
    }
    const plaintext = decryptBaselineModel(
      { ciphertext: encrypted.modelBlob, nonce: encrypted.modelNonce },
      userId,
      baselineEncryptionKey,
    );
    return BaselineModelSchema.parse(JSON.parse(plaintext.toString('utf8')));
  }

  return {
    /**
     * Score a post-login sample for a user with an ACTIVE baseline and write a
     * risk_events row. Returns the non-secret outcome. Mismatches are recorded as
     * not-scored events (never a crash, never a raw vector in the log).
     */
    async scoreLogin(
      userId: string,
      deviceId: string | null,
      sample: SampleToScore,
    ): Promise<ScoreOutcome> {
      const model = await loadActiveModel(userId);
      if (!model) {
        return { scored: false, reason: 'no_active_baseline' };
      }

      const result = scoreSample(model, sample);
      const riskEvents = createRiskEventsRepository(pool);

      if (result.scored) {
        await riskEvents.insert({
          userId,
          deviceId,
          signals: { keystroke: { score: result.score, reason: result.reason } },
          behavioralScore: result.score,
          compositeScore: result.score, // no other signals yet (context is M8)
          policyBand: OBSERVED_POLICY_BAND,
          actionTaken: OBSERVED_ACTION,
          outcome: 'scored',
        });
        return { scored: true, score: result.score };
      }

      // Not scored (dimension/schema mismatch or singular cov): record as such.
      await riskEvents.insert({
        userId,
        deviceId,
        signals: { keystroke: { score: null, reason: { status: 'not_scored', cause: result.reason } } },
        behavioralScore: null,
        compositeScore: 0,
        policyBand: OBSERVED_POLICY_BAND,
        actionTaken: OBSERVED_ACTION,
        outcome: 'not_scored',
      });
      return { scored: false, reason: result.reason };
    },
  };
}

export type ScoringService = ReturnType<typeof createScoringService>;
