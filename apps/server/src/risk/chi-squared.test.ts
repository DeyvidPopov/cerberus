import { describe, expect, it } from 'vitest';

import { chiSquaredCdf, chiSquaredSf } from './chi-squared';

describe('chiSquaredCdf — against known values', () => {
  it('matches closed-form values', () => {
    // χ²₁ ≤ 1 ⟺ |Z| ≤ 1 ⇒ 0.6827
    expect(chiSquaredCdf(1, 1)).toBeCloseTo(0.6827, 3);
    // χ²₂ CDF = 1 − e^(−x/2); at x=2 ⇒ 1 − e⁻¹ = 0.6321
    expect(chiSquaredCdf(2, 2)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(chiSquaredCdf(0, 2)).toBe(0);
  });

  it('matches published upper-5% critical values (CDF ≈ 0.95)', () => {
    expect(chiSquaredCdf(3.8415, 1)).toBeCloseTo(0.95, 3); // df=1
    expect(chiSquaredCdf(11.0705, 5)).toBeCloseTo(0.95, 3); // df=5
    expect(chiSquaredCdf(18.307, 10)).toBeCloseTo(0.95, 3); // df=10
    expect(chiSquaredCdf(43.773, 30)).toBeCloseTo(0.95, 3); // df=30
    expect(chiSquaredCdf(44.985, 31)).toBeCloseTo(0.95, 3); // df=31 (the CMU dimension)
  });

  it('is monotonically increasing in x', () => {
    let prev = -1;
    for (let x = 0; x <= 60; x += 0.5) {
      const v = chiSquaredCdf(x, 10);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBeGreaterThan(0.99);
  });

  it('returns 0 at/below the mean point and approaches 1 far out', () => {
    expect(chiSquaredCdf(0, 31)).toBe(0);
    expect(chiSquaredCdf(200, 31)).toBeGreaterThan(0.9999);
  });
});

describe('chiSquaredSf — survival (the p-value)', () => {
  it('is the complement of the CDF', () => {
    for (const [x, dof] of [
      [5, 5],
      [10, 10],
      [31, 31],
      [50, 31],
    ] as const) {
      expect(chiSquaredCdf(x, dof) + chiSquaredSf(x, dof)).toBeCloseTo(1, 10);
    }
  });

  it('is 1 at the mean and tiny far out', () => {
    expect(chiSquaredSf(0, 31)).toBe(1);
    expect(chiSquaredSf(200, 31)).toBeLessThan(1e-4);
  });
});

describe('out-of-domain inputs (fail closed, PROJECT.md §1.5)', () => {
  it('treats +Infinity distance as maximally anomalous, NaN as benign', () => {
    // +∞ D² ⇒ CDF 1 (max anomaly) / SF 0 (p-value 0) — never "least anomalous".
    expect(chiSquaredCdf(Number.POSITIVE_INFINITY, 31)).toBe(1);
    expect(chiSquaredSf(Number.POSITIVE_INFINITY, 31)).toBe(0);
    // NaN ⇒ benign default (0 / 1), not a crash.
    expect(chiSquaredCdf(Number.NaN, 31)).toBe(0);
    expect(chiSquaredSf(Number.NaN, 31)).toBe(1);
  });
});
