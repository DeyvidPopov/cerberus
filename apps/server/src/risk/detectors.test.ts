import { describe, expect, it } from 'vitest';

import { DEFAULT_EVALUATION_CONFIG } from './config';
import {
  isolationForestDetector,
  mahalanobisDetector,
  ocSvmDetector,
  type DetectorFactory,
} from './detectors';
import { averagePathLength } from './detectors/isolation-forest';
import { createPrng } from './random';

// A tight Gaussian-ish cluster around `center` (deterministic — no Math.random).
function cluster(n: number, dimension: number, center: number, spread: number): number[][] {
  const prng = createPrng(42);
  const samples: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < dimension; j += 1) {
      row.push(center + (prng() - 0.5) * spread);
    }
    samples.push(row);
  }
  return samples;
}

const DIM = 8;
const train = cluster(80, DIM, 100, 4);
const inlier = new Array<number>(DIM).fill(100);
const outlier = new Array<number>(DIM).fill(140); // far outside the cluster

const detectors: DetectorFactory[] = [
  mahalanobisDetector(),
  ocSvmDetector(DEFAULT_EVALUATION_CONFIG),
  isolationForestDetector(DEFAULT_EVALUATION_CONFIG),
];

describe.each(detectors)('detector: $name', (detector) => {
  it('scores a clear outlier as MORE anomalous than an inlier', () => {
    const scorer = detector.train(train);
    expect(scorer(outlier)).toBeGreaterThan(scorer(inlier));
  });

  it('produces finite scores', () => {
    const scorer = detector.train(train);
    expect(Number.isFinite(scorer(inlier))).toBe(true);
    expect(Number.isFinite(scorer(outlier))).toBe(true);
  });
});

describe('isolation forest c(n) (Liu et al. 2008 known answers)', () => {
  it('uses the exact harmonic for small n (c(1)=0, c(2)=1)', () => {
    expect(averagePathLength(1)).toBe(0);
    expect(averagePathLength(2)).toBe(1); // exact H(1)=1, not the asymptotic 0.154
    expect(averagePathLength(3)).toBeCloseTo(1.2074, 3);
  });
});

describe('determinism', () => {
  it('isolation forest is reproducible (same seed ⇒ same scores)', () => {
    const a = isolationForestDetector(DEFAULT_EVALUATION_CONFIG).train(train);
    const b = isolationForestDetector(DEFAULT_EVALUATION_CONFIG).train(train);
    expect(a(outlier)).toBe(b(outlier));
    expect(a(inlier)).toBe(b(inlier));
  });

  it('one-class SVM is deterministic (no randomness)', () => {
    const a = ocSvmDetector(DEFAULT_EVALUATION_CONFIG).train(train);
    const b = ocSvmDetector(DEFAULT_EVALUATION_CONFIG).train(train);
    expect(a(outlier)).toBe(b(outlier));
  });
});
