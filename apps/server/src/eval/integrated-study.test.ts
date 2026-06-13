import { describe, expect, it } from 'vitest';

import { analyzeAttempts, parseAttemptsJsonl, type LabeledAttempt } from './integrated-study';

// A fixture of labeled end-to-end attempts with KNOWN, hand-countable outcomes.
const FIXTURE: LabeledAttempt[] = [
  // Genuine logins: 4 granted, 1 stepped-up (false step-up), 1 denied (false reject).
  { label: 'genuine', channel: 'login', action: 'granted' },
  { label: 'genuine', channel: 'login', action: 'granted' },
  { label: 'genuine', channel: 'login', action: 'granted' },
  { label: 'genuine', channel: 'login', action: 'granted' },
  { label: 'genuine', channel: 'login', action: 'step_up_required' },
  { label: 'genuine', channel: 'login', action: 'denied' },
  // Impostor logins: 1 granted (false accept), 1 bootstrap-granted (false accept),
  // 2 stepped-up (caught), 1 denied (caught).
  { label: 'impostor', channel: 'login', action: 'granted' },
  { label: 'impostor', channel: 'login', action: 'step_up_bootstrap_grant' },
  { label: 'impostor', channel: 'login', action: 'step_up_required' },
  { label: 'impostor', channel: 'login', action: 'step_up_required' },
  { label: 'impostor', channel: 'login', action: 'denied' },
  // Continuous: 1 genuine locked (false lock) of 4 genuine; 3 impostor locked of 4.
  { label: 'genuine', channel: 'continuous', action: 'granted' },
  { label: 'genuine', channel: 'continuous', action: 'granted' },
  { label: 'genuine', channel: 'continuous', action: 'granted' },
  { label: 'genuine', channel: 'continuous', action: 'session_locked' },
  { label: 'impostor', channel: 'continuous', action: 'session_locked' },
  { label: 'impostor', channel: 'continuous', action: 'session_locked' },
  { label: 'impostor', channel: 'continuous', action: 'session_locked' },
  { label: 'impostor', channel: 'continuous', action: 'granted' },
];

describe('analyzeAttempts — policy-level metrics from labeled attempts', () => {
  it('computes the documented metrics from a fixture', () => {
    const m = analyzeAttempts(FIXTURE);
    expect(m.counts).toEqual({
      total: 19,
      genuineLogins: 6,
      impostorLogins: 5,
      genuineContinuous: 4,
      impostorContinuous: 4,
    });
    // 2 of 5 impostor logins effectively granted (granted + bootstrap).
    expect(m.compositeFar).toBeCloseTo(2 / 5, 10);
    // 1 of 6 genuine logins hard-denied.
    expect(m.compositeFrr).toBeCloseTo(1 / 6, 10);
    // 3 step-ups (1 genuine + 2 impostor) of 11 login attempts.
    expect(m.stepUpRate).toBeCloseTo(3 / 11, 10);
    // 1 of 6 genuine logins stepped up.
    expect(m.falseStepUpRate).toBeCloseTo(1 / 6, 10);
    // 3 of 5 impostor logins caught (2 step-up + 1 deny).
    expect(m.impostorCaughtRate).toBeCloseTo(3 / 5, 10);
    // 1 of 4 genuine continuous sessions locked.
    expect(m.falseLockRate).toBeCloseTo(1 / 4, 10);
    // 3 of 4 impostor continuous sessions locked.
    expect(m.trueLockRate).toBeCloseTo(3 / 4, 10);
  });

  it('returns null for a rate with no attempts of that kind (no divide-by-zero)', () => {
    const m = analyzeAttempts([{ label: 'genuine', channel: 'login', action: 'granted' }]);
    expect(m.compositeFar).toBeNull(); // no impostor logins
    expect(m.falseLockRate).toBeNull(); // no continuous sessions
    expect(m.compositeFrr).toBeCloseTo(0, 10);
  });
});

describe('parseAttemptsJsonl', () => {
  it('parses + validates JSONL, skipping blanks and # comments', () => {
    const jsonl = [
      '# a labeled study (synthetic)',
      JSON.stringify({ label: 'genuine', channel: 'login', action: 'granted' }),
      '',
      JSON.stringify({ label: 'impostor', channel: 'continuous', action: 'session_locked' }),
    ].join('\n');
    expect(parseAttemptsJsonl(jsonl)).toHaveLength(2);
  });

  it('throws on an invalid record (untrusted input is validated)', () => {
    expect(() => parseAttemptsJsonl(JSON.stringify({ label: 'nope', channel: 'login', action: 'granted' }))).toThrow();
  });
});
