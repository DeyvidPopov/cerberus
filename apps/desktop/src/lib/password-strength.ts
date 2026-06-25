// Client-side master-password guidance for ACCOUNT CREATION.
//
// The master password is the root of the zero-knowledge vault: it derives the vault key
// in Rust and NEVER leaves the device (PROJECT.md §1, §4.2). The server is zero-knowledge,
// so it can't (and must not) see or grade the password — strength can ONLY be assessed
// HERE, in the webview, on the plaintext as it is typed. This module is pure: it sends
// nothing anywhere; it just powers a meter + a soft gate so a weak master password isn't
// chosen. (Modern guidance — NIST 800-63B — favours length + a weak-password block over
// rigid composition rules, so length is the dominant factor and a long passphrase passes.)

const MIN_LENGTH = 12;

/** A small set of well-known weak passwords (lower-cased exact match). */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '123456',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwertyuiop',
  'letmein',
  'welcome',
  'admin',
  'iloveyou',
  'abc123',
  'monkey',
  'dragon',
  'master',
  'login',
  'princess',
  'sunshine',
  'football',
  'baseball',
  '111111',
  '000000',
  'qazwsx',
  'trustno1',
  'secret',
  'changeme',
  'whatever',
]);

export interface PasswordStrength {
  /** 0..4 — drives the segmented meter. */
  score: 0 | 1 | 2 | 3 | 4;
  label: 'Too weak' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  /** Whether it clears the MINIMUM bar to create a vault. */
  acceptable: boolean;
  checks: {
    /** At least MIN_LENGTH characters. */
    length: boolean;
    /** ≥ 2 character types, OR a genuinely long passphrase. */
    variety: boolean;
    /** Not a well-known / trivially-guessable password. */
    notCommon: boolean;
  };
}

function characterClasses(pw: string): number {
  let n = 0;
  if (/[a-z]/u.test(pw)) n += 1;
  if (/[A-Z]/u.test(pw)) n += 1;
  if (/[0-9]/u.test(pw)) n += 1;
  if (/[^a-zA-Z0-9]/u.test(pw)) n += 1;
  return n;
}

/** A trivially-guessable password: a known-common one, a single repeated char, or an
 *  obvious keyboard/number sequence. */
function isWeakPattern(pw: string): boolean {
  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return true;
  }
  if (/^(.)\1+$/u.test(pw)) {
    return true; // all one repeated character
  }
  return /^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/u.test(lower);
}

const LABELS = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/** Grade a candidate master password (purely client-side). */
export function evaluatePassword(pw: string): PasswordStrength {
  const len = pw.length;
  const classes = characterClasses(pw);
  const weak = isWeakPattern(pw);

  const checks = {
    length: len >= MIN_LENGTH,
    variety: classes >= 2 || len >= 20,
    notCommon: len > 0 && !weak,
  };

  let score: 0 | 1 | 2 | 3 | 4 = 0;
  if (len >= 8) {
    score = 1;
  }
  if (len >= MIN_LENGTH && classes >= 2) {
    score = 2;
  }
  if (len >= 14 && classes >= 3) {
    score = 3;
  }
  if ((len >= 16 && classes >= 3) || len >= 20) {
    score = 4;
  }
  if (weak || len < 8) {
    score = 0; // a guessable or very short password is never more than "Too weak"
  }

  const acceptable = checks.length && checks.notCommon && score >= 2;
  return { score, label: LABELS[score], acceptable, checks };
}
