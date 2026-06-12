// Shared ServerConfig builder for tests. Centralizes the non-secret test config
// so adding a field to ServerConfig touches one place, not every test file.
// Limits are set generously so rate-limiting never interferes unless a test
// overrides them explicitly.
import { randomBytes } from 'node:crypto';

import type { ServerConfig } from '../config';
import {
  DEFAULT_BACKSTOP_CONFIG,
  DEFAULT_BAND_THRESHOLDS,
  DEFAULT_BEHAVIORAL_CONFIG,
  DEFAULT_COMBINER_WEIGHTS,
  DEFAULT_CONTEXTUAL_CONFIG,
  DEFAULT_TOTP_CONFIG,
} from '../risk/config';

export function testServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    nodeEnv: 'test',
    logLevel: 'error',
    databaseUrl: 'unused-in-tests',
    enumerationSecret: 'test-enumeration-secret',
    sessionTtlMs: 60_000,
    rateLimit: {
      ipWindowMs: 60_000,
      ipMaxRequests: 10_000,
      accountMaxFailures: 1000,
      accountLockoutMs: 60_000,
      vaultWindowMs: 60_000,
      vaultMaxRequests: 10_000,
    },
    // A random per-run at-rest key; tests never depend on a fixed value.
    baselineEncryptionKey: randomBytes(32),
    behavioral: { ...DEFAULT_BEHAVIORAL_CONFIG },
    contextual: { ...DEFAULT_CONTEXTUAL_CONFIG },
    policy: {
      weights: DEFAULT_COMBINER_WEIGHTS,
      thresholds: DEFAULT_BAND_THRESHOLDS,
      backstop: DEFAULT_BACKSTOP_CONFIG,
      totp: DEFAULT_TOTP_CONFIG,
    },
    geoipDbPath: undefined,
    // Trust proxy so tests can drive the client IP via X-Forwarded-For.
    trustProxy: true,
    ...overrides,
  };
}
