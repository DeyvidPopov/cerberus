import { describe, expect, it } from 'vitest';

import { DEFAULT_BAND_THRESHOLDS as T } from './config';
import { atLeast, bandFor, escalate } from './policy';

describe('bandFor', () => {
  it('grants below the step-up threshold', () => {
    expect(bandFor(0, T)).toBe('grant');
    expect(bandFor(T.stepUp - 0.01, T)).toBe('grant');
  });

  it('steps up between the thresholds (inclusive at stepUp — fail closed)', () => {
    expect(bandFor(T.stepUp, T)).toBe('step_up');
    expect(bandFor((T.stepUp + T.deny) / 2, T)).toBe('step_up');
    expect(bandFor(T.deny - 0.01, T)).toBe('step_up');
  });

  it('denies at/above the deny threshold (inclusive — fail closed)', () => {
    expect(bandFor(T.deny, T)).toBe('deny');
    expect(bandFor(1, T)).toBe('deny');
  });
});

describe('escalate / atLeast', () => {
  it('escalate returns the more restrictive band', () => {
    expect(escalate('grant', 'step_up')).toBe('step_up');
    expect(escalate('deny', 'step_up')).toBe('deny');
    expect(escalate('grant', 'grant')).toBe('grant');
    expect(escalate('step_up', 'deny')).toBe('deny');
  });

  it('atLeast compares restrictiveness', () => {
    expect(atLeast('deny', 'step_up')).toBe(true);
    expect(atLeast('step_up', 'step_up')).toBe(true);
    expect(atLeast('grant', 'step_up')).toBe(false);
  });
});
