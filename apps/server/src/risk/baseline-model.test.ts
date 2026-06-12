import { describe, expect, it } from 'vitest';

import { choleskyDecompose, fitBaseline, invertSpd } from './baseline-model';

const at = (m: readonly number[][], i: number, j: number): number => m[i]?.[j] ?? 0;

// Build the raw (unregularized) MLE sample covariance, to prove it is singular
// without shrinkage — the exact condition the regularization exists to fix.
function rawSampleCovariance(samples: readonly number[][]): number[][] {
  const n = samples.length;
  const d = samples[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  for (const row of samples) {
    for (let j = 0; j < d; j += 1) {
      mean[j] = (mean[j] ?? 0) + (row[j] ?? 0) / n;
    }
  }
  const cov: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const row of samples) {
    for (let i = 0; i < d; i += 1) {
      const ci = cov[i];
      if (ci === undefined) {
        continue;
      }
      for (let j = 0; j < d; j += 1) {
        ci[j] = (ci[j] ?? 0) + ((row[i] ?? 0) - (mean[i] ?? 0)) * ((row[j] ?? 0) - (mean[j] ?? 0)) / n;
      }
    }
  }
  return cov;
}

// Deterministic synthetic samples: N vectors of dimension d, with per-feature
// variation so the covariance is non-trivial (no Math.random — reproducible).
function makeSamples(n: number, d: number): number[][] {
  const samples: number[][] = [];
  for (let s = 0; s < n; s += 1) {
    const row: number[] = [];
    for (let j = 0; j < d; j += 1) {
      row.push(50 + j * 3 + Math.sin((s + 1) * 1.7 + (j + 1) * 0.9) * 8);
    }
    samples.push(row);
  }
  return samples;
}

function matMul(a: readonly number[][], b: readonly number[][]): number[][] {
  const d = a.length;
  const out: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i += 1) {
    const oi = out[i];
    if (oi === undefined) {
      continue;
    }
    for (let j = 0; j < d; j += 1) {
      let acc = 0;
      for (let k = 0; k < d; k += 1) {
        acc += at(a, i, k) * at(b, k, j);
      }
      oi[j] = acc;
    }
  }
  return out;
}

describe('fitBaseline — mean and shape', () => {
  it('computes the per-feature mean and a square covariance', () => {
    const samples = [
      [10, 20, 30, 40],
      [12, 18, 30, 44],
      [14, 22, 30, 36],
    ];
    const fit = fitBaseline(samples);
    expect(fit.dimension).toBe(4);
    expect(fit.sampleCount).toBe(3);
    expect(fit.mean).toEqual([12, 20, 30, 40]);
    expect(fit.covariance).toHaveLength(4);
    expect(fit.covariance[0]).toHaveLength(4);
  });

  it('produces a symmetric covariance', () => {
    const c = fitBaseline(makeSamples(10, 13)).covariance;
    for (let i = 0; i < c.length; i += 1) {
      for (let j = 0; j < c.length; j += 1) {
        expect(at(c, i, j)).toBeCloseTo(at(c, j, i), 9);
      }
    }
  });

  it('keeps the shrinkage intensity in [0,1]', () => {
    const fit = fitBaseline(makeSamples(10, 13));
    expect(fit.shrinkage).toBeGreaterThanOrEqual(0);
    expect(fit.shrinkage).toBeLessThanOrEqual(1);
  });
});

describe('covariance regularization — invertible / well-conditioned', () => {
  it('REGULARIZATION IS NECESSARY: raw covariance is singular when N < d', () => {
    // 6 samples, dimension 13 (a 5-keystroke password): rank ≤ 5 < 13 ⇒ singular.
    const raw = rawSampleCovariance(makeSamples(6, 13));
    expect(choleskyDecompose(raw)).toBeNull(); // not positive-definite (no inverse)
  });

  it('REGULARIZATION WORKS: fitted covariance is positive-definite (invertible)', () => {
    const fit = fitBaseline(makeSamples(6, 13));
    expect(choleskyDecompose(fit.covariance)).not.toBeNull(); // PD ⇒ invertible
  });

  it('the inverse satisfies Σ·Σ⁻¹ ≈ I (what M7 Mahalanobis needs)', () => {
    const fit = fitBaseline(makeSamples(6, 13));
    const inv = invertSpd(fit.covariance);
    expect(inv).not.toBeNull();
    if (inv === null) {
      return;
    }
    const product = matMul(fit.covariance, inv);
    for (let i = 0; i < product.length; i += 1) {
      for (let j = 0; j < product.length; j += 1) {
        expect(at(product, i, j)).toBeCloseTo(i === j ? 1 : 0, 6);
      }
    }
  });

  it('stays positive-definite even when all samples are identical (ridge floor)', () => {
    const identical = Array.from({ length: 10 }, () => [5, 5, 5, 5]);
    const fit = fitBaseline(identical);
    expect(fit.ridge).toBeGreaterThan(0);
    expect(choleskyDecompose(fit.covariance)).not.toBeNull();
  });

  it('rejects ragged or empty input (fail closed)', () => {
    expect(() => fitBaseline([])).toThrow();
    expect(() =>
      fitBaseline([
        [1, 2, 3],
        [1, 2],
      ]),
    ).toThrow();
  });
});
