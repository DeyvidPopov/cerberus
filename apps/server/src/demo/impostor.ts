// DEMO-ONLY entrypoint: `npm run demo:impostor`. Logs in as the demo account with a
// DELIBERATELY strongly-anomalous keystroke sample so the (UNMODIFIED) behavioral
// scorer flags it and the adaptive policy bands it to a step-up — a reliable, on-cue
// demonstration of behavioral step-up. It does NOT change scoring, thresholds, or any
// policy; it only feeds a known-bad sample to the real /auth/login endpoint.
//
// Requires the dev server to be running and the demo account to be seeded
// (`npm run demo:seed`). Hard-gated to non-production; refuses a non-local database.
import { loadConfig } from '../config';
import { runCli, type AuthKeyResult } from './cli';
import {
  DEMO_DEVICE_FINGERPRINT,
  DEMO_FEATURE_SCHEMA_VERSION,
  DEMO_MASTER_PASSWORD,
  DEMO_USERNAME,
  assertDevDemoEnvironment,
} from './env';
import { impostorSample } from './samples';

function apiBaseUrl(): string {
  return process.env.DEMO_API_BASE_URL ?? process.env.VITE_API_BASE_URL ?? 'http://localhost:8080';
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertDevDemoEnvironment(config.databaseUrl);
  const base = apiBaseUrl();

  // 1. prelogin → the demo account's KDF salt/params.
  const pre = await postJson(`${base}/auth/prelogin`, { username: DEMO_USERNAME });
  if (pre.status !== 200) {
    throw new Error(`prelogin failed (${String(pre.status)}). Is the server running and seeded (npm run demo:seed)?`);
  }

  // 2. Derive the demo auth key with the Rust oracle (real client-side derivation).
  const { authKey } = runCli<AuthKeyResult>('derive-auth-key', {
    masterPassword: DEMO_MASTER_PASSWORD,
    kdfSalt: pre.json.kdfSalt,
    kdfParams: pre.json.kdfParams,
  });

  // 3. Log in with the known-bad keystroke sample (correct dimension ⇒ it is SCORED).
  const login = await postJson(`${base}/auth/login`, {
    username: DEMO_USERNAME,
    authKey,
    deviceFingerprintHash: DEMO_DEVICE_FINGERPRINT,
    keystrokeSample: { featureSchemaVersion: DEMO_FEATURE_SCHEMA_VERSION, features: impostorSample() },
  });

  const status = typeof login.json.status === 'string' ? login.json.status : `http_${String(login.status)}`;
  console.log(`\n[demo:impostor] strongly-anomalous login → outcome: ${status}`);
  if (login.status === 200 && status === 'step_up_required') {
    console.log('  ✓ Behavioral step-up FIRED as intended. Complete the TOTP in the app to get in.');
  } else if (login.status === 200 && status === 'granted') {
    console.log('  ! Login was granted (the seeded baseline may be loose). Re-seed with a tighter');
    console.log('    baseline via `npm run demo:reset`, or lower BAND_STEP_UP for the demo.');
  } else if (login.status === 403) {
    console.log('  Access was denied. Ensure the demo account is seeded with a confirmed TOTP and');
    console.log('  a known device (npm run demo:seed) so the anomaly bands to step-up, not deny.');
  } else {
    console.log(`  Unexpected outcome (HTTP ${String(login.status)}): ${JSON.stringify(login.json)}`);
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error('demo:impostor failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
