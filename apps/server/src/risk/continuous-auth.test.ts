import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTINUOUS_AUTH_CONFIG } from './config';
import { isSpike, updateInSessionComposite } from './continuous-auth';

const ALPHA = DEFAULT_CONTINUOUS_AUTH_CONFIG.ewmaAlpha;

describe('updateInSessionComposite (EWMA)', () => {
  it('starts neutral and a single anomalous window does not reach the spike threshold', () => {
    const c1 = updateInSessionComposite(0, 1, ALPHA); // one high window from neutral
    expect(c1).toBeCloseTo(ALPHA, 10); // 0.5 with the default alpha
    expect(isSpike(c1, DEFAULT_CONTINUOUS_AUTH_CONFIG)).toBe(false);
  });

  it('a sustained anomaly crosses the threshold within a few windows (fail closed)', () => {
    let c = 0;
    const crossings: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      c = updateInSessionComposite(c, 1, ALPHA);
      crossings.push(isSpike(c, DEFAULT_CONTINUOUS_AUTH_CONFIG));
    }
    // 0.5, 0.75, 0.875, 0.9375 → spikes once it exceeds 0.85.
    expect(crossings).toEqual([false, false, true, true]);
  });

  it('a stream of low (matching) windows stays well below the threshold', () => {
    let c = 0;
    for (let i = 0; i < 20; i += 1) {
      c = updateInSessionComposite(c, 0.02, ALPHA);
    }
    expect(c).toBeLessThan(0.1);
    expect(isSpike(c, DEFAULT_CONTINUOUS_AUTH_CONFIG)).toBe(false);
  });

  it('clamps to [0,1] and maps NaN to neutral (never a spurious spike)', () => {
    expect(updateInSessionComposite(0, Number.NaN, ALPHA)).toBe(0);
    expect(updateInSessionComposite(2, 2, ALPHA)).toBe(1);
  });
});
