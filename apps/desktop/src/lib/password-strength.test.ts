import { describe, expect, it } from 'vitest';

import { evaluatePassword } from './password-strength';

describe('evaluatePassword (client-side master-password guidance)', () => {
  it('rejects empty, short, and common passwords', () => {
    expect(evaluatePassword('').acceptable).toBe(false);
    expect(evaluatePassword('short').acceptable).toBe(false);
    const common = evaluatePassword('password');
    expect(common.acceptable).toBe(false);
    expect(common.checks.notCommon).toBe(false);
  });

  it('accepts a strong mixed-class password', () => {
    const s = evaluatePassword('Tr0ub4dour&3xtra');
    expect(s.acceptable).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(3);
    expect(s.checks).toEqual({ length: true, variety: true, notCommon: true });
  });

  it('accepts a long passphrase even with low character variety (length wins)', () => {
    const s = evaluatePassword('correct horse battery staple');
    expect(s.checks.length).toBe(true);
    expect(s.acceptable).toBe(true);
    expect(s.score).toBe(4);
  });

  it('flags a long-enough but single-class password as not-yet-acceptable', () => {
    const s = evaluatePassword('kxmpqrtwvbns'); // 12 lowercase, not a sequence
    expect(s.checks.length).toBe(true);
    expect(s.checks.variety).toBe(false); // only one character class, not long enough
    expect(s.acceptable).toBe(false);
  });

  it('blocks repeated characters and obvious sequences', () => {
    expect(evaluatePassword('aaaaaaaaaaaa').acceptable).toBe(false);
    expect(evaluatePassword('123456789012').checks.notCommon).toBe(false);
  });
});
