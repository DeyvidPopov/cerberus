// Behavioral scoring service (ADR-0002, ADR-0010). Loads a user's ACTIVE baseline
// (decrypts the model-only blob) and scores a fresh post-login keystroke vector
// with Mahalanobis → chi-squared. It now RETURNS the behavioral evaluation; the
// behavioral facade writes the single combined risk_events row (M8 merges the
// contextual signals into the same row). NO enforcement (logged only).
//
// PRIVACY (PROJECT.md §5): the raw feature vector is biometric-adjacent and is
// NEVER returned beyond the score + a structured reason (distance, dof, p-value,
// model metadata).
import type { Pool } from 'pg';

import { createBehavioralBaselinesRepository, type Modality } from '../repositories/behavioral-baselines';
import { BaselineModelSchema, scoreSample, type BaselineModel, type SampleToScore } from '../risk/scorer';
import { decryptBaselineModel } from './baseline-crypto';

export interface ScoringServiceDeps {
  pool: Pool;
  baselineEncryptionKey: Buffer;
  /** Which behavioral modality this scorer loads baselines for (default keystroke). */
  modality?: Modality;
}

/** The behavioral leg of a login's risk evaluation (no DB write here). */
export interface BehavioralEvaluation {
  /** Behavioral sub-score in [0,1], or null when not scored. */
  behavioralScore: number | null;
  /** The `signals.keystroke` object (score + structured reason). */
  keystroke: Record<string, unknown>;
  /** Behavioral outcome for the risk_events row. */
  outcome: 'scored' | 'not_scored';
}

export function createScoringService(deps: ScoringServiceDeps) {
  const { pool, baselineEncryptionKey } = deps;
  const modality = deps.modality ?? 'keystroke';

  async function loadActiveModel(userId: string): Promise<BaselineModel | null> {
    const encrypted = await createBehavioralBaselinesRepository(pool).findActiveModel(userId, modality);
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
     * Score a post-login sample for a user with an ACTIVE baseline. Returns the
     * behavioral evaluation (score + keystroke signal + outcome). Mismatches are
     * returned as not-scored with a cause — never a crash, never a raw vector.
     */
    async scoreActive(userId: string, sample: SampleToScore): Promise<BehavioralEvaluation> {
      const model = await loadActiveModel(userId);
      if (!model) {
        return {
          behavioralScore: null,
          keystroke: { score: null, reason: { status: 'not_scored', cause: 'no_active_baseline' } },
          outcome: 'not_scored',
        };
      }

      const result = scoreSample(model, sample);
      if (result.scored) {
        return {
          behavioralScore: result.score,
          keystroke: { score: result.score, reason: result.reason },
          outcome: 'scored',
        };
      }
      return {
        behavioralScore: null,
        keystroke: { score: null, reason: { status: 'not_scored', cause: result.reason } },
        outcome: 'not_scored',
      };
    },
  };
}

export type ScoringService = ReturnType<typeof createScoringService>;
