// Account flow orchestration (PROJECT.md §2 — lib/). Wires the Rust key
// derivation (IPC) to the server API (HTTP). The master password is passed to
// Rust only; it never reaches the server or browser storage (PROJECT.md §1, §4.2).
import {
  FEATURE_SCHEMA_VERSION,
  type GrantedLoginResponse,
  type StepUpVerifyRequest,
} from '@cerberus/shared-types';

import { login, prelogin, register, verifyStepUp } from './api';
import { deviceFingerprintHash } from './device';
import { deriveLoginAuthKey, prepareRegistration } from './tauri';

/**
 * The outcome of a login: a granted session, or a step-up challenge that must be
 * satisfied with a TOTP code (ADR-0012). A hard deny surfaces as an ApiError(403).
 */
export type LoginOutcome =
  | { kind: 'granted'; session: GrantedLoginResponse }
  | { kind: 'step_up'; challengeToken: string; expiresAt: string };

/**
 * Register a new account. Rust derives the auth key + encryption key, generates
 * the salt and vault key, and wraps it; only that material (plus the username) is
 * sent to the server.
 */
export async function registerAccount(username: string, masterPassword: string): Promise<void> {
  const material = await prepareRegistration(masterPassword);
  await register({ username, ...material });
}

/**
 * Log in: fetch KDF params (prelogin) → derive the auth key in Rust → send it with
 * the hashed device fingerprint AND the position-indexed keystroke sample (durations
 * only; the master password never crosses the wire). The server runs the adaptive
 * policy and either grants a session or requires a TOTP step-up (ADR-0012).
 */
export async function loginAccount(
  username: string,
  masterPassword: string,
  keystrokeFeatures: number[] | null,
): Promise<LoginOutcome> {
  const params = await prelogin({ username });
  const authKey = await deriveLoginAuthKey(masterPassword, params.kdfSalt, params.kdfParams);
  const deviceFingerprint = await deviceFingerprintHash();
  const response = await login({
    username,
    authKey,
    deviceFingerprintHash: deviceFingerprint,
    keystrokeSample:
      keystrokeFeatures === null
        ? undefined
        : { featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: keystrokeFeatures },
  });
  if (response.status === 'granted') {
    return { kind: 'granted', session: response };
  }
  return { kind: 'step_up', challengeToken: response.challengeToken, expiresAt: response.expiresAt };
}

/** Complete a step-up with a TOTP code, returning the now-granted session. */
export async function completeStepUp(req: StepUpVerifyRequest): Promise<GrantedLoginResponse> {
  return verifyStepUp(req);
}
