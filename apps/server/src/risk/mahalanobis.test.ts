import { describe, expect, it } from 'vitest';

import { mahalanobisSquared } from './mahalanobis';

function identity(d: number): number[][] {
  return Array.from({ length: d }, (_unused, i) =>
    Array.from({ length: d }, (_u, j) => (i === j ? 1 : 0)),
  );
}

describe('mahalanobisSquared', () => {
  it('is zero at the mean', () => {
    expect(mahalanobisSquared([1, 2, 3], [1, 2, 3], identity(3))).toBe(0);
  });

  it('reduces to squared Euclidean distance under identity covariance', () => {
    // diff = [3,4] ⇒ D² = 9 + 16 = 25
    expect(mahalanobisSquared([3, 4], [0, 0], identity(2))).toBe(25);
  });

  it('scales features by the inverse covariance', () => {
    // inverse cov diag(1/4, 1/9); diff [2,3] ⇒ 4/4 + 9/9 = 2
    const inv = [
      [0.25, 0],
      [0, 1 / 9],
    ];
    expect(mahalanobisSquared([2, 3], [0, 0], inv)).toBeCloseTo(2, 10);
  });

  it('accounts for off-diagonal correlation', () => {
    // Σ = [[1,0.5],[0.5,1]] ⇒ Σ⁻¹ = (1/0.75)[[1,-0.5],[-0.5,1]]
    const inv = [
      [1 / 0.75, -0.5 / 0.75],
      [-0.5 / 0.75, 1 / 0.75],
    ];
    // diff [1,1] ⇒ (1 - 0.5 - 0.5 + 1)/0.75 = 1/0.75
    expect(mahalanobisSquared([1, 1], [0, 0], inv)).toBeCloseTo(1 / 0.75, 10);
  });

  it('never returns a negative distance (float round-off clamp)', () => {
    expect(mahalanobisSquared([0, 0], [0, 0], identity(2))).toBeGreaterThanOrEqual(0);
  });
});
