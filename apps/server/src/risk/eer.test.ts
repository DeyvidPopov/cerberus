import { describe, expect, it } from 'vitest';

import { equalErrorRate, meanStd } from './eer';

describe('equalErrorRate', () => {
  it('is ~0 for perfectly separable scores', () => {
    // genuine all low, impostor all high ⇒ a threshold separates them with no error.
    const result = equalErrorRate([0, 0.1, 0.2, 0.3], [1, 1.1, 1.2, 1.3]);
    expect(result.eer).toBeCloseTo(0, 6);
    expect(result.far).toBeCloseTo(0, 6);
    expect(result.frr).toBeCloseTo(0, 6);
  });

  it('computes a known partial-overlap EER exactly', () => {
    // genuine [0,1,2,3], impostor [2,3,4,5]: FAR=FRR=0.25 at the crossover.
    const result = equalErrorRate([0, 1, 2, 3], [2, 3, 4, 5]);
    expect(result.eer).toBeCloseTo(0.25, 6);
  });

  it('is ~0.5 for identical genuine/impostor distributions', () => {
    const same = [1, 2, 3, 4, 5];
    const result = equalErrorRate(same, same);
    expect(result.eer).toBeGreaterThan(0.4);
    expect(result.eer).toBeLessThanOrEqual(0.5);
  });

  it('throws on an empty score set (fail closed — a harness bug, not 0% error)', () => {
    expect(() => equalErrorRate([], [1, 2])).toThrow();
    expect(() => equalErrorRate([1, 2], [])).toThrow();
  });
});

describe('meanStd', () => {
  it('computes mean and population std', () => {
    const { mean, std } = meanStd([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(mean).toBeCloseTo(5, 10);
    expect(std).toBeCloseTo(2, 10);
  });

  it('returns zeros for an empty list', () => {
    expect(meanStd([])).toEqual({ mean: 0, std: 0 });
  });
});
