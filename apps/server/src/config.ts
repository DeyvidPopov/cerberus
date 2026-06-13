// Application configuration, read from the environment (PROJECT.md §7).
// Read once at startup. Secrets are never logged (PROJECT.md §5).
import {
  DEFAULT_BACKSTOP_CONFIG,
  DEFAULT_BAND_THRESHOLDS,
  DEFAULT_BEHAVIORAL_CONFIG,
  DEFAULT_COMBINER_WEIGHTS,
  DEFAULT_CONTEXTUAL_CONFIG,
  DEFAULT_CONTINUOUS_AUTH_CONFIG,
  DEFAULT_TOTP_CONFIG,
  type BackstopConfig,
  type BandThresholds,
  type BehavioralConfig,
  type CombinerWeights,
  type ContextualConfig,
  type ContinuousAuthConfig,
  type TotpConfig,
} from './risk/config';

/** Adaptive-policy config (M9 / ADR-0012): combiner weights, band thresholds, brute-force backstop, TOTP. */
export interface PolicyConfig {
  readonly weights: CombinerWeights;
  readonly thresholds: BandThresholds;
  readonly backstop: BackstopConfig;
  readonly totp: TotpConfig;
}

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
  /** Adaptive-policy config (ADR-0012). */
  readonly policy: PolicyConfig;
  /** Continuous-auth (mouse) config (ADR-0013): mouse enrollment + in-session spike→lock. */
  readonly continuousAuth: ContinuousAuthConfig;
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
  /**
   * Origins allowed to call the API cross-origin (the desktop webview). The Tauri
   * app runs at its own origin and must be allow-listed for register/login etc. to
   * reach the server (CORS). Env CORS_ALLOWED_ORIGINS (comma-separated) overrides.
   */
  readonly corsAllowedOrigins: string[];
}

const DEFAULT_PORT = 8080;
const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/cerberus';
const DEV_ENUMERATION_SECRET = 'dev-only-enumeration-secret-change-me';
// The desktop app's origins: the Vite dev server (devUrl) + the built-app custom
// protocol origins (Windows uses http(s)://tauri.localhost; others tauri://localhost).
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:1420',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
];
// A fixed, obviously-non-secret 32-byte dev key. Production refuses to start with it.
const DEV_BASELINE_KEY_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000';

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function floatFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? '');
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Comma-separated env list (trimmed, empties dropped), or the fallback. */
function csvFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
    policy: {
      weights: DEFAULT_COMBINER_WEIGHTS,
      thresholds: {
        stepUp: floatFromEnv('BAND_STEP_UP', DEFAULT_BAND_THRESHOLDS.stepUp),
        deny: floatFromEnv('BAND_DENY', DEFAULT_BAND_THRESHOLDS.deny),
      },
      backstop: {
        ...DEFAULT_BACKSTOP_CONFIG,
        ipHardCap: intFromEnv('BACKSTOP_IP_CAP', DEFAULT_BACKSTOP_CONFIG.ipHardCap),
        accountStepUpCap: intFromEnv('BACKSTOP_ACCOUNT_CAP', DEFAULT_BACKSTOP_CONFIG.accountStepUpCap),
      },
      totp: DEFAULT_TOTP_CONFIG,
    },
    continuousAuth: {
      ...DEFAULT_CONTINUOUS_AUTH_CONFIG,
      minEnrollmentSamples: intFromEnv(
        'MOUSE_MIN_ENROLLMENT_SAMPLES',
        DEFAULT_CONTINUOUS_AUTH_CONFIG.minEnrollmentSamples,
      ),
      ewmaAlpha: floatFromEnv('CONTINUOUS_AUTH_EWMA_ALPHA', DEFAULT_CONTINUOUS_AUTH_CONFIG.ewmaAlpha),
      spikeThreshold: floatFromEnv(
        'CONTINUOUS_AUTH_SPIKE_THRESHOLD',
        DEFAULT_CONTINUOUS_AUTH_CONFIG.spikeThreshold,
      ),
    },
    geoipDbPath: process.env.GEOIP_DB_PATH,
    trustProxy: trustProxyFromEnv(),
    corsAllowedOrigins: csvFromEnv('CORS_ALLOWED_ORIGINS', DEFAULT_CORS_ORIGINS),
  };
}
