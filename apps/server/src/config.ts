// Application configuration, read from the environment (PROJECT.md §7).
// Read once at startup. Secrets are never logged (PROJECT.md §5).

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
}

const DEFAULT_PORT = 8080;
const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/cerberus';
const DEV_ENUMERATION_SECRET = 'dev-only-enumeration-secret-change-me';

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
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
  };
}
