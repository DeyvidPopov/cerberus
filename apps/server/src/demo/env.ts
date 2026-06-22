// DEMO-ONLY tooling — shared guards + constants (docs/DEMO.md).
//
// NONE of this is production code: it is invoked ONLY by the `demo:*` npm scripts
// and is hard-gated to non-production. It creates/destroys a throwaway demo account
// on a LOCAL dev database. It never changes scoring, policy, or any production path.
import { featureDimension, FEATURE_SCHEMA_VERSION } from '@cerberus/shared-types';

/** The demo account's fixed identity (printed for the operator; not a secret of value). */
export const DEMO_USERNAME = 'demo';
/**
 * The demo master password. Deliberately SHIFT-FREE and exactly 11 keystrokes so
 * that, when typed into the desktop app, the captured keystroke sample has the same
 * dimension as the seeded baseline (featureDimension(11) = 31) and is therefore
 * SCORED rather than rejected as a dimension mismatch.
 */
export const DEMO_MASTER_PASSWORD = 'demovault77';

/** Keystrokes in the demo password ⇒ the baseline/sample feature dimension. */
export const DEMO_KEYSTROKE_COUNT = DEMO_MASTER_PASSWORD.length; // 11
export const DEMO_FEATURE_DIM = featureDimension(DEMO_KEYSTROKE_COUNT); // 31
export const DEMO_FEATURE_SCHEMA_VERSION = FEATURE_SCHEMA_VERSION;

/**
 * A fixed device fingerprint hash (base64) the seed enrolls as a KNOWN device, so a
 * later demo login (and the impostor helper) is on a known device — a NEW device
 * would let the contextual signal dominate and could deny instead of step-up.
 */
export const DEMO_DEVICE_FINGERPRINT = Buffer.from('cerberus-demo-device-fixed-00000', 'utf8').toString('base64');

/** A few example credentials seeded as opaque AEAD blobs (server stores ciphertext only). */
export const DEMO_CREDENTIALS = [
  { name: 'GitHub', username: 'demo@cerberus.dev', password: 'gh-demo-pw-001', url: 'https://github.com', notes: 'Demo credential.' },
  { name: 'Email', username: 'demo@cerberus.dev', password: 'mail-demo-pw-002', url: 'https://mail.example', notes: '' },
  { name: 'Bank', username: 'demo-customer', password: 'bank-demo-pw-003', url: 'https://bank.example', notes: 'Demo only — not real.' },
] as const;

/**
 * Refuse to run demo tooling unless this is clearly a development environment:
 *   - NODE_ENV must NOT be 'production', and
 *   - the database must be LOCAL (127.0.0.1 / localhost / ::1), unless the operator
 *     explicitly sets DEMO_ALLOW_NONLOCAL_DB=yes for a known throwaway dev DB.
 * Throws a clear error otherwise (fail closed — never touch a real database).
 */
export function assertDevDemoEnvironment(databaseUrl: string): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    throw new Error('DEMO tooling is DISABLED in production (NODE_ENV=production). Refusing to run.');
  }
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL; refusing to run demo tooling.');
  }
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!local && process.env.DEMO_ALLOW_NONLOCAL_DB !== 'yes') {
    throw new Error(
      `DEMO tooling refuses to run against a NON-LOCAL database (host=${host}). ` +
        'Point DATABASE_URL at a local dev database, or set DEMO_ALLOW_NONLOCAL_DB=yes ' +
        'only if you are certain this is a throwaway dev database.',
    );
  }
}
