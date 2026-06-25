import { describe, expect, it } from 'vitest';

import { buildRiskExplanation } from './risk-explanation';

describe('buildRiskExplanation (demo deny breakdown)', () => {
  it('maps a recorded signals object to contributions, reasons, and the top driver', () => {
    const signals = {
      keystroke: { score: 0.9, confidence: 'normal', reason: { pValue: 0.001 } },
      newDevice: { score: 1, reason: { known: false, trusted: false, firstSeen: null } },
      geovelocity: { score: 0, reason: { status: 'insufficient_geo' } },
      timeOfDay: { score: 0.1, reason: { currentHour: 3 } },
      failureVelocity: { score: 0.4, reason: { accountFailures: 5, ipFailures: 2, windowMinutes: 10, scope: 'account' } },
      combiner: {
        contributions: { behavioral: 0.45, newDevice: 0.35, geovelocity: 0, timeOfDay: 0.02, failureVelocity: 0.14 },
        compositeScore: 0.96,
      },
    };
    const exp = buildRiskExplanation(signals, 0.7);

    expect(exp.composite).toBeCloseTo(0.96, 5);
    expect(exp.threshold).toBe(0.7);
    // The highest contribution (behavioral 0.45) is named as the driver.
    expect(exp.driver).toBe('Behavioral — typing rhythm');
    expect(exp.signals).toHaveLength(5);

    const behavioral = exp.signals.find((s) => s.label.startsWith('Behavioral'));
    expect(behavioral?.contribution).toBeCloseTo(0.45, 5);
    expect(behavioral?.reason).toMatch(/deviates sharply/iu);

    const newDevice = exp.signals.find((s) => s.label === 'New device');
    expect(newDevice?.reason).toMatch(/device we have not seen/iu);

    const failures = exp.signals.find((s) => s.label === 'Recent failures');
    expect(failures?.reason).toMatch(/5 recent failed attempts/iu);
  });

  it('is robust to a malformed / empty signals object (never throws)', () => {
    const exp = buildRiskExplanation({}, 0.7);
    expect(exp.signals).toHaveLength(5);
    expect(exp.composite).toBe(0);
    expect(exp.driver).toBeTruthy();
  });
});
