import { describe, expect, it } from 'vitest';

import { combine } from './combiner';
import { DEFAULT_COMBINER_WEIGHTS as W } from './config';

const ZERO = { newDevice: 0, geovelocity: 0, timeOfDay: 0, failureVelocity: 0 };

describe('combine — weighted-linear composite', () => {
  it('is 0 when every signal is 0', () => {
    const r = combine(0, ZERO, W);
    expect(r.compositeScore).toBe(0);
    expect(r.contextScore).toBe(0);
  });

  it('a single contextual signal contributes exactly its weight', () => {
    const r = combine(0, { ...ZERO, newDevice: 1 }, W);
    expect(r.compositeScore).toBeCloseTo(W.newDevice, 6);
    expect(r.contextScore).toBeCloseTo(W.newDevice, 6);
    expect(r.contributions.newDevice).toBeCloseTo(W.newDevice, 6);
  });

  it('the behavioral sub-score contributes its weight', () => {
    const r = combine(1, ZERO, W);
    expect(r.compositeScore).toBeCloseTo(W.behavioral, 6);
    expect(r.contextScore).toBe(0); // behavioral is not contextual
    expect(r.contributions.behavioral).toBeCloseTo(W.behavioral, 6);
  });

  it('contributions sum to the (pre-clamp) composite — the decision is explainable', () => {
    const r = combine(0.4, { newDevice: 0.3, geovelocity: 0.2, timeOfDay: 1, failureVelocity: 0.1 }, W);
    const sum =
      r.contributions.behavioral +
      r.contributions.newDevice +
      r.contributions.geovelocity +
      r.contributions.timeOfDay +
      r.contributions.failureVelocity;
    expect(r.compositeScore).toBeCloseTo(Math.min(1, sum), 4);
  });

  it('clamps a stacked-signal composite to 1', () => {
    const r = combine(1, { newDevice: 1, geovelocity: 1, timeOfDay: 1, failureVelocity: 1 }, W);
    expect(r.compositeScore).toBe(1);
    expect(r.contextScore).toBe(1);
  });

  it('separates context_score (contextual only) from composite (incl. behavioral)', () => {
    const r = combine(1, { ...ZERO, geovelocity: 1 }, W);
    expect(r.contextScore).toBeCloseTo(W.geovelocity, 6);
    expect(r.compositeScore).toBeCloseTo(Math.min(1, W.behavioral + W.geovelocity), 6);
  });
});
