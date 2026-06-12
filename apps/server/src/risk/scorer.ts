// Live behavioral scorer (ADR-0002, ADR-0010). PURE: given a deserialized baseline
// model and a fresh sample, it produces a Mahalanobis → chi-squared anomaly score.
// It NEVER touches the database, the network, or the password. No enforcement —
// the score is computed and returned for logging (the service writes risk_events).
//
// Score semantics: `score` ∈ [0,1], higher = MORE anomalous (= chi-squared CDF of
// D² = 1 − pValue). A sample at the mean scores 0; a far sample scores → 1.
import { z } from 'zod';

import { fitBaseline, invertSpd } from './baseline-model';
import { chiSquaredCdf, chiSquaredSf } from './chi-squared';
import { mahalanobisSquared } from './mahalanobis';

/**
 * The fitted-baseline model as decrypted from storage. Validated with zod after
 * decryption — the decrypted blob is a trust boundary too (PROJECT.md §4.2).
 */
export const BaselineModelSchema = z.object({
  featureSchemaVersion: z.number().int().positive(),
  modelVersion: z.number().int().positive(),
  dimension: z.number().int().positive(),
  sampleCount: z.number().int().nonnegative(),
  mean: z.array(z.number().finite()),
  covariance: z.array(z.array(z.number().finite())),
  shrinkage: z.number(),
  ridge: z.number(),
});
export type BaselineModel = z.infer<typeof BaselineModelSchema>;

export interface ScoredReason {
  /** Mahalanobis distance D (not squared). */
  distance: number;
  /** Squared Mahalanobis distance D² (the chi-squared variate). */
  distanceSquared: number;
  /** Degrees of freedom (= feature dimension). */
  dof: number;
  /** Chi-squared p-value P(χ²_dof > D²): small ⇒ anomalous. */
  pValue: number;
  /** Model version + sample count for explainability (no raw timings). */
  modelVersion: number;
  sampleCount: number;
}

export type ScoreResult =
  | { scored: true; score: number; reason: ScoredReason }
  | {
      scored: false;
      reason: 'dimension_mismatch' | 'schema_version_mismatch' | 'singular_covariance';
    };

export interface SampleToScore {
  featureSchemaVersion: number;
  features: number[];
}

/**
 * Score a sample against a baseline model. Fails closed and explicit on any
 * mismatch (never a crash, never a silent wrong number):
 *  - schema_version_mismatch: the sample's feature schema ≠ the baseline's.
 *  - dimension_mismatch: the vector length ≠ the baseline dimension.
 *  - singular_covariance: the stored covariance is not invertible (should not
 *    happen — M6 guarantees SPD — but handled rather than assumed).
 */
export function scoreSample(model: BaselineModel, sample: SampleToScore): ScoreResult {
  if (sample.featureSchemaVersion !== model.featureSchemaVersion) {
    return { scored: false, reason: 'schema_version_mismatch' };
  }
  if (sample.features.length !== model.dimension) {
    return { scored: false, reason: 'dimension_mismatch' };
  }
  const inverse = invertSpd(model.covariance);
  if (inverse === null) {
    return { scored: false, reason: 'singular_covariance' };
  }
  const distanceSquared = mahalanobisSquared(sample.features, model.mean, inverse);
  const dof = model.dimension;
  const pValue = chiSquaredSf(distanceSquared, dof);
  const score = chiSquaredCdf(distanceSquared, dof); // = 1 − pValue
  return {
    scored: true,
    score,
    reason: {
      distance: Math.sqrt(distanceSquared),
      distanceSquared,
      dof,
      pValue,
      modelVersion: model.modelVersion,
      sampleCount: model.sampleCount,
    },
  };
}

/**
 * Convenience for the offline Mahalanobis detector (Part B): fit a baseline from
 * training vectors and return a scoring closure (D², higher = more anomalous),
 * reusing the SAME fit + inverse + distance as the live scorer (apples-to-apples).
 */
export function trainMahalanobisDetector(trainingVectors: number[][]): (x: number[]) => number {
  const fitted = fitBaseline(trainingVectors);
  const inverse = invertSpd(fitted.covariance);
  if (inverse === null) {
    throw new Error('fitted covariance is not invertible');
  }
  return (x: number[]): number => mahalanobisSquared(x, fitted.mean, inverse);
}
