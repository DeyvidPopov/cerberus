import { describe, expect, it } from 'vitest';

import { chiSquaredCdf } from './chi-squared';
import { scoreSample, type BaselineModel } from './scorer';

function identity(d: number): number[][] {
  return Array.from({ length: d }, (_unused, i) =>
    Array.from({ length: d }, (_u, j) => (i === j ? 1 : 0)),
  );
}

// A baseline with mean 0 and identity covariance: D² = squared Euclidean norm,
// so the chi-squared mapping is exactly checkable.
function unitModel(dimension: number): BaselineModel {
  return {
    featureSchemaVersion: 1,
    modelVersion: 1,
    dimension,
    sampleCount: 10,
    mean: new Array<number>(dimension).fill(0),
    covariance: identity(dimension),
    shrinkage: 0,
    ridge: 0,
  };
}

describe('scoreSample — Mahalanobis → chi-squared score', () => {
  it('a sample equal to the mean is minimally anomalous (score 0, p-value 1)', () => {
    const result = scoreSample(unitModel(4), { featureSchemaVersion: 1, features: [0, 0, 0, 0] });
    expect(result.scored).toBe(true);
    if (!result.scored) {
      return;
    }
    expect(result.score).toBe(0);
    expect(result.reason.distance).toBe(0);
    expect(result.reason.pValue).toBe(1);
  });

  it('maps D² to the chi-squared CDF exactly (identity covariance)', () => {
    // features [1,1,1,1] ⇒ D² = 4, dof = 4
    const result = scoreSample(unitModel(4), { featureSchemaVersion: 1, features: [1, 1, 1, 1] });
    expect(result.scored).toBe(true);
    if (!result.scored) {
      return;
    }
    expect(result.reason.distanceSquared).toBeCloseTo(4, 10);
    expect(result.reason.dof).toBe(4);
    expect(result.score).toBeCloseTo(chiSquaredCdf(4, 4), 10);
    expect(result.reason.pValue).toBeCloseTo(1 - chiSquaredCdf(4, 4), 10);
  });

  it('a far sample is highly anomalous (score → 1, p-value → 0)', () => {
    const result = scoreSample(unitModel(4), {
      featureSchemaVersion: 1,
      features: [10, 10, 10, 10],
    });
    expect(result.scored).toBe(true);
    if (!result.scored) {
      return;
    }
    expect(result.score).toBeGreaterThan(0.999);
    expect(result.reason.pValue).toBeLessThan(0.001);
  });

  it('the score increases monotonically with distance from the mean', () => {
    const near = scoreSample(unitModel(4), { featureSchemaVersion: 1, features: [0.5, 0, 0, 0] });
    const mid = scoreSample(unitModel(4), { featureSchemaVersion: 1, features: [2, 0, 0, 0] });
    const far = scoreSample(unitModel(4), { featureSchemaVersion: 1, features: [5, 0, 0, 0] });
    expect(near.scored && mid.scored && far.scored).toBe(true);
    if (near.scored && mid.scored && far.scored) {
      expect(near.score).toBeLessThan(mid.score);
      expect(mid.score).toBeLessThan(far.score);
    }
  });

  it('fails closed on a schema-version mismatch (not scored, no crash)', () => {
    const result = scoreSample(unitModel(4), { featureSchemaVersion: 999, features: [0, 0, 0, 0] });
    expect(result).toEqual({ scored: false, reason: 'schema_version_mismatch' });
  });

  it('fails closed on a dimension mismatch (not scored, no crash)', () => {
    const result = scoreSample(unitModel(4), { featureSchemaVersion: 1, features: [0, 0, 0] });
    expect(result).toEqual({ scored: false, reason: 'dimension_mismatch' });
  });
});
