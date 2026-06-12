// Application configuration, read from the environment (PROJECT.md §7).
// Read once at startup. Secrets are never logged (PROJECT.md §5).
import {
  DEFAULT_BEHAVIORAL_CONFIG,
  DEFAULT_CONTEXTUAL_CONFIG,
  type BehavioralConfig,
  type ContextualConfig,
} from './risk/config';

export interface RateLimitConfig {
  /** Per-IP sliding window for login/prelogin. */
  readonly ipWindowMs: number;
  readonly ipMaxRequests: number;
  /** Per-account lockout after this many consecutive failed logins. */
  readonly accountMaxFailures: number;
  readonly accountLockoutMs: number;
  /** Per-user window for authenticated vault sync endpoints (PROJECT.md §4.3). */
  readonly vaultWindowMs: number;
  readonly vaultMaxRequests: number;
}

export interface ServerConfig {
  readonly port: number;
  readonly nodeEnv: string;
  readonly logLevel: string;
  readonly databaseUrl: string;
  /** Secret keying the user-enumeration mitigation (ADR-0007). MUST be set in prod. */
  readonly enumerationSecret: string;
  readonly sessionTtlMs: number;
  readonly rateLimit: RateLimitConfig;
  /**
   * Server-managed 32-byte key encrypting behavioral baselines at rest (ADR-0002,
   * ADR-0009). SEPARATE from any user vault key. MUST be set in production.
   */
  readonly baselineEncryptionKey: Buffer;
  /** Behavioral enrollment config (ADR-0009). */
  readonly behavioral: BehavioralConfig;
  /** Contextual risk-signal config (ADR-0011). */
  readonly contextual: ContextualConfig;
  /**
   * Path to a local MaxMind GeoLite2-City .mmdb for offline geo (ADR-0011). When
   * unset/missing the geovelocity signal stays neutral. Never an external API.
   */
  readonly geoipDbPath: string | undefined;
  /**
   * Express `trust proxy` setting so the real client IP is read behind a reverse
   * proxy (the M4 open item). A number of hops, a boolean, or a preset string.
   */
  readonly trustProxy: boolean | number | string;
}

const DEFAULT_PORT = 8080;
const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/cerberus';
const DEV_ENUMERATION_SECRET = 'dev-only-enumeration-secret-change-me';
// A fixed, obviously-non-secret 32-byte dev key. Production refuses to start with it.
const DEV_BASELINE_KEY_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000';

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Parse the Express trust-proxy setting from env: number of hops | boolean | preset. */
function trustProxyFromEnv(): boolean | number | string {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') {
    return false; // by default read the socket address (no proxy assumed)
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const hops = Number.parseInt(raw, 10);
  return Number.isNaN(hops) ? raw : hops;
}

/** Decode a 32-byte key from hex (64 chars) or base64; throw if it is not 32 bytes. */
function decodeKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/u.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('BASELINE_ENC_KEY must decode to 32 bytes (hex or base64).');
  }
  return key;
}

function loadBaselineKey(nodeEnv: string): Buffer {
  const raw = process.env.BASELINE_ENC_KEY;
  if (raw === undefined || raw === '') {
    if (nodeEnv === 'production') {
      throw new Error('BASELINE_ENC_KEY must be set in production (ADR-0009).');
    }
    return Buffer.from(DEV_BASELINE_KEY_HEX, 'hex');
  }
  return decodeKey(raw);
}

export function loadConfig(): ServerConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  const enumerationSecret = process.env.ENUMERATION_SECRET ?? DEV_ENUMERATION_SECRET;
  if (nodeEnv === 'production' && enumerationSecret === DEV_ENUMERATION_SECRET) {
    // Fail closed-ish: refuse to start production with the public dev secret,
    // which would let an attacker recompute dummy salts and enumerate users.
    throw new Error('ENUMERATION_SECRET must be set in production (ADR-0007).');
  }

  return {
    port: intFromEnv('PORT', DEFAULT_PORT),
    nodeEnv,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    enumerationSecret,
    sessionTtlMs: intFromEnv('SESSION_TTL_MS', 24 * 60 * 60 * 1000),
    rateLimit: {
      ipWindowMs: intFromEnv('RL_IP_WINDOW_MS', 15 * 60 * 1000),
      ipMaxRequests: intFromEnv('RL_IP_MAX', 100),
      accountMaxFailures: intFromEnv('RL_ACCOUNT_MAX_FAILURES', 5),
      accountLockoutMs: intFromEnv('RL_ACCOUNT_LOCKOUT_MS', 15 * 60 * 1000),
      vaultWindowMs: intFromEnv('RL_VAULT_WINDOW_MS', 15 * 60 * 1000),
      vaultMaxRequests: intFromEnv('RL_VAULT_MAX', 600),
    },
    baselineEncryptionKey: loadBaselineKey(nodeEnv),
    behavioral: {
      ...DEFAULT_BEHAVIORAL_CONFIG,
      minEnrollmentSamples: intFromEnv(
        'MIN_ENROLLMENT_SAMPLES',
        DEFAULT_BEHAVIORAL_CONFIG.minEnrollmentSamples,
      ),
    },
    contextual: {
      ...DEFAULT_CONTEXTUAL_CONFIG,
      failureVelocity: {
        ...DEFAULT_CONTEXTUAL_CONFIG.failureVelocity,
        windowMinutes: intFromEnv(
          'FAILURE_VELOCITY_WINDOW_MIN',
          DEFAULT_CONTEXTUAL_CONFIG.failureVelocity.windowMinutes,
        ),
      },
    },
    geoipDbPath: process.env.GEOIP_DB_PATH,
    trustProxy: trustProxyFromEnv(),
  };
}
