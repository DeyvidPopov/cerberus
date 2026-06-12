// Shared ServerConfig builder for tests. Centralizes the non-secret test config
// so adding a field to ServerConfig touches one place, not every test file.
// Limits are set generously so rate-limiting never interferes unless a test
// overrides them explicitly.
import { randomBytes } from 'node:crypto';

import type { ServerConfig } from '../config';
import { DEFAULT_BEHAVIORAL_CONFIG } from '../risk/config';

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
    ...overrides,
  };
}
