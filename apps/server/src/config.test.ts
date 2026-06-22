import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from './config';
import { DEFAULT_BEHAVIORAL_CONFIG, DEFAULT_CONTINUOUS_AUTH_CONFIG } from './risk/config';

// The DEMO-only config knobs must be honored OUTSIDE production and IGNORED inside
// it (so a demo override can never weaken a shipped build). Production defaults are
// unchanged either way.
const SAVED_ENV = { ...process.env };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined); // silence the override notice
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  vi.restoreAllMocks();
});

function withEnv(env: Record<string, string>): void {
  process.env = { ...SAVED_ENV, ...env };
}

const DEMO_OVERRIDES = {
  MIN_ENROLLMENT_SAMPLES: '3',
  MOUSE_MIN_ENROLLMENT_SAMPLES: '4',
  CONTINUOUS_AUTH_EWMA_ALPHA: '0.9',
  CONTINUOUS_AUTH_SPIKE_THRESHOLD: '0.35',
};

// Production loadConfig refuses the dev enumeration secret / missing baseline key.
const PROD_SECRETS = {
  NODE_ENV: 'production',
  ENUMERATION_SECRET: 'a-real-production-enumeration-secret',
  BASELINE_ENC_KEY: 'a'.repeat(64), // 32 bytes hex
};

describe('config — DEMO-only knobs are gated to non-production', () => {
  it('honors the demo overrides outside production (development)', () => {
    withEnv({ NODE_ENV: 'development', ...DEMO_OVERRIDES });
    const config = loadConfig();
    expect(config.behavioral.minEnrollmentSamples).toBe(3);
    expect(config.continuousAuth.minEnrollmentSamples).toBe(4);
    expect(config.continuousAuth.ewmaAlpha).toBe(0.9);
    expect(config.continuousAuth.spikeThreshold).toBe(0.35);
  });

  it('IGNORES the demo overrides in production (secure defaults apply)', () => {
    withEnv({ ...PROD_SECRETS, ...DEMO_OVERRIDES });
    const config = loadConfig();
    expect(config.behavioral.minEnrollmentSamples).toBe(DEFAULT_BEHAVIORAL_CONFIG.minEnrollmentSamples); // 10
    expect(config.continuousAuth.minEnrollmentSamples).toBe(DEFAULT_CONTINUOUS_AUTH_CONFIG.minEnrollmentSamples); // 12
    expect(config.continuousAuth.ewmaAlpha).toBe(DEFAULT_CONTINUOUS_AUTH_CONFIG.ewmaAlpha); // 0.5
    expect(config.continuousAuth.spikeThreshold).toBe(DEFAULT_CONTINUOUS_AUTH_CONFIG.spikeThreshold); // 0.85
  });

  it('production defaults are unchanged when no override is set', () => {
    withEnv({ ...PROD_SECRETS });
    const config = loadConfig();
    expect(config.behavioral.minEnrollmentSamples).toBe(10);
    expect(config.continuousAuth.minEnrollmentSamples).toBe(12);
    expect(config.continuousAuth.spikeThreshold).toBe(0.85);
  });
});
