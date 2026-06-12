// Account flow orchestration (PROJECT.md §2 — lib/). Wires the Rust key
// derivation (IPC) to the server API (HTTP). The master password is passed to
// Rust only; it never reaches the server or browser storage (PROJECT.md §1, §4.2).
import type { LoginResponse } from '@cerberus/shared-types';

import { login, prelogin, register } from './api';
import { deviceFingerprintHash } from './device';
import { deriveLoginAuthKey, prepareRegistration } from './tauri';

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
 * Log in: fetch KDF params (prelogin) → derive the auth key in Rust → send it
 * with the hashed device fingerprint. On success the response carries the session
 * token and the wrapped vault key (unlocking the local vault from it integrates
 * with vault-sync, Phase 1).
 */
export async function loginAccount(
  username: string,
  masterPassword: string,
): Promise<LoginResponse> {
  const params = await prelogin({ username });
  const authKey = await deriveLoginAuthKey(masterPassword, params.kdfSalt, params.kdfParams);
  const deviceFingerprint = await deviceFingerprintHash();
  return login({ username, authKey, deviceFingerprintHash: deviceFingerprint });
}
