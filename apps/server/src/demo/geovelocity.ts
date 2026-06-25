// DEMO-ONLY entrypoint: `npm run demo:geovelocity`. Demonstrates the geovelocity
// ("impossible travel") signal END TO END without a MaxMind GeoLite2 database.
//
// It signs the demo account in from the US, then seconds later from JAPAN — SAME device,
// SAME (genuine) typing — using the dev/demo `X-Demo-Geo` override to simulate location.
// The ONLY thing that changes is the country, so the adaptive policy escalating the
// second sign-in (grant → step-up) is attributable to geovelocity alone. It changes no
// scoring or policy. Hard-gated to non-production; refuses a non-local database, and the
// `X-Demo-Geo` override is itself ignored by a production server.
//
// Requires the dev server running and the demo account seeded (`npm run demo:seed`).
import { loadConfig } from '../config';
import { runCli, type AuthKeyResult } from './cli';
import {
  DEMO_DEVICE_FINGERPRINT,
  DEMO_FEATURE_SCHEMA_VERSION,
  DEMO_MASTER_PASSWORD,
  DEMO_USERNAME,
  assertDevDemoEnvironment,
} from './env';
import { realisticGenuineSample } from './samples';

function apiBaseUrl(): string {
  return process.env.DEMO_API_BASE_URL ?? process.env.VITE_API_BASE_URL ?? 'http://localhost:8080';
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

function outcomeOf(res: { status: number; json: Record<string, unknown> }): string {
  return typeof res.json.status === 'string' ? res.json.status : `http_${String(res.status)}`;
}

async function signIn(
  base: string,
  authKey: string,
  country: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return postJson(
    `${base}/auth/login`,
    {
      username: DEMO_USERNAME,
      authKey,
      deviceFingerprintHash: DEMO_DEVICE_FINGERPRINT, // SAME known device both times
      keystrokeSample: { featureSchemaVersion: DEMO_FEATURE_SCHEMA_VERSION, features: realisticGenuineSample() },
    },
    { 'x-demo-geo': country },
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertDevDemoEnvironment(config.databaseUrl);
  const base = apiBaseUrl();

  const pre = await postJson(`${base}/auth/prelogin`, { username: DEMO_USERNAME });
  if (pre.status !== 200) {
    throw new Error(`prelogin failed (${String(pre.status)}). Is the server running and seeded (npm run demo:seed)?`);
  }
  const { authKey } = runCli<AuthKeyResult>('derive-auth-key', {
    masterPassword: DEMO_MASTER_PASSWORD,
    kdfSalt: pre.json.kdfSalt,
    kdfParams: pre.json.kdfParams,
  });

  // 1. Sign in from the US → establishes the "previous location".
  const us = outcomeOf(await signIn(base, authKey, 'US'));
  // 2. Seconds later, from JAPAN → an impossible hop (same device + typing).
  const jp = outcomeOf(await signIn(base, authKey, 'JP'));

  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  DEMO: geovelocity / impossible travel (location only — same device & typing)');
  console.log(line);
  console.log(`  Sign-in from US  → ${us}`);
  console.log(`  Sign-in from JP  → ${jp}`);
  console.log(line);
  if (us === 'granted' && (jp === 'step_up_required' || jp === 'denied')) {
    console.log('  ✓ Geo WORKS: the only change was the country, and it escalated the JP sign-in.');
    console.log('    Open the Risk inspector (step-up session) to see the geovelocity sub-score.');
  } else if (jp === 'granted') {
    console.log('  ! The JP sign-in was still granted. Ensure the server is NON-production and using');
    console.log('    the demo geo (it logs "[geo] … using the DEMO geo table"), then re-run.');
  } else {
    console.log(`  Unexpected: US=${us}, JP=${jp}. Re-seed (npm run demo:seed) and ensure the server is up.`);
  }
  console.log(`${line}\n`);
}

main().catch((error: unknown) => {
  console.error('demo:geovelocity failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
