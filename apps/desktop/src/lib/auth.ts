// Account flow orchestration (PROJECT.md §2 — lib/). Wires the Rust key
// derivation (IPC) to the server API (HTTP). The master password is passed to
// Rust only; it never reaches the server or browser storage (PROJECT.md §1, §4.2).
import {
  FEATURE_SCHEMA_VERSION,
  type GrantedLoginResponse,
  type KdfParams,
  type MergeOutcome,
  type StepUpVerifyRequest,
} from '@cerberus/shared-types';

import { login, prelogin, register, verifyStepUp } from './api';
import { deviceFingerprintHash } from './device';
import { syncPullOnUnlock } from './sync';
import { deriveLoginAuthKey, prepareRegistration, unlock } from './tauri';

/**
 * The outcome of a login: a granted session, or a step-up challenge that must be
 * satisfied with a TOTP code (ADR-0012). A hard deny surfaces as an ApiError(403).
 *
 * Both carry the prelogin KDF salt/params so the caller can open the local vault AND
 * pull-sync from the server once access is granted (directly, or after a step-up).
 */
export type LoginOutcome =
  | { kind: 'granted'; session: GrantedLoginResponse; kdfSalt: string; kdfParams: KdfParams }
  | { kind: 'step_up'; challengeToken: string; expiresAt: string; kdfSalt: string; kdfParams: KdfParams };

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
    return { kind: 'granted', session: response, kdfSalt: params.kdfSalt, kdfParams: params.kdfParams };
  }
  return {
    kind: 'step_up',
    challengeToken: response.challengeToken,
    expiresAt: response.expiresAt,
    kdfSalt: params.kdfSalt,
    kdfParams: params.kdfParams,
  };
}

/** Complete a step-up with a TOTP code, returning the now-granted session. */
export async function completeStepUp(req: StepUpVerifyRequest): Promise<GrantedLoginResponse> {
  return verifyStepUp(req);
}

/**
 * Open the LOCAL Rust vault so the in-memory encryption key is held and the vault
 * becomes usable (list/add/reveal). Call this only AFTER the server has GRANTED
 * access (direct grant, or after a passed step-up) — a denied/step-up-pending login
 * must never open the local vault (fail closed, ADR-0012). The master password is
 * forwarded to the Rust core, which derives + unwraps the vault key; it never
 * reaches the server (PROJECT.md §1, §4.2). On first run this initializes the vault.
 *
 * `vaultId` (the account's username) scopes the LOCAL vault file per account, so two
 * accounts on one machine never collide on a single shared vault.
 */
export async function unlockVault(masterPassword: string, vaultId: string): Promise<void> {
  await unlock(masterPassword, vaultId);
}

/**
 * Open the local vault AND pull-sync it from the server (ADR-0008): unlock, then
 * reconcile the server's encrypted items into the local vault (server → local, by
 * revision). This is what makes a SECOND DEVICE or a REINSTALL reconstruct the full
 * vault on unlock instead of showing an empty one.
 *
 * The unlock is authoritative for "is the vault usable": if it fails, this throws
 * (the caller keeps the vault LOCKED). The pull is BEST-EFFORT — a network/server
 * failure or a corrupt blob must NOT block the now-usable local vault; it is swallowed
 * (and reconciles on the next unlock). Returns the merge counts, or null if the pull
 * did not complete. Decryption is client-side only; the server holds only ciphertext.
 */
export async function unlockAndPull(
  masterPassword: string,
  session: GrantedLoginResponse,
  kdfSalt: string,
  kdfParams: KdfParams,
  vaultId: string,
): Promise<MergeOutcome | null> {
  await unlockVault(masterPassword, vaultId);
  try {
    return await syncPullOnUnlock({
      token: session.sessionToken,
      masterPassword,
      kdfSalt,
      kdfParams,
      wrappedVaultKey: session.wrappedVaultKey,
      wrappedVaultKeyNonce: session.wrappedVaultKeyNonce,
    });
  } catch {
    return null; // offline / server error / undecryptable: keep the local vault usable
  }
}
