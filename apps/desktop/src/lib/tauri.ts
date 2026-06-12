// Bridge to the Rust core via Tauri commands (PROJECT.md §2 — lib/).
//
// The webview never holds derived keys (PROJECT.md §1.2): it forwards the master
// password to Rust and receives non-secret DTOs (and, for `get`, the requested
// credential's plaintext to display). EVERY reply crossing back from Rust is
// validated at runtime with zod before use — trust nothing across the process
// boundary, including replies from Rust (PROJECT.md §4.2).
import {
  Base64ResultSchema,
  CredentialIdSchema,
  CredentialSchema,
  CredentialSummaryListSchema,
  RegistrationMaterialSchema,
  type Credential,
  type CredentialInput,
  type CredentialSummary,
  type KdfParams,
  type RegistrationMaterial,
} from '@cerberus/shared-types';
import { invoke } from '@tauri-apps/api/core';

// Command-argument keys use snake_case to match the Rust parameter names exactly.

/**
 * Derive registration material in Rust (auth key, KDF params, wrapped vault key).
 * The master password never leaves Rust; only non-key material is returned.
 */
export async function prepareRegistration(masterPassword: string): Promise<RegistrationMaterial> {
  const result: unknown = await invoke('prepare_registration', {
    master_password: masterPassword,
  });
  return RegistrationMaterialSchema.parse(result);
}

/** Derive the login auth key in Rust from the master password and KDF params. */
export async function deriveLoginAuthKey(
  masterPassword: string,
  kdfSalt: string,
  kdfParams: KdfParams,
): Promise<string> {
  const result: unknown = await invoke('derive_login_auth_key_cmd', {
    master_password: masterPassword,
    kdf_salt: kdfSalt,
    kdf_params: kdfParams,
  });
  return Base64ResultSchema.parse(result);
}

export async function unlock(masterPassword: string): Promise<void> {
  await invoke('unlock', { master_password: masterPassword });
}

export async function lock(): Promise<void> {
  await invoke('lock');
}

export async function addCredential(input: CredentialInput): Promise<string> {
  const result: unknown = await invoke('add_credential', { input });
  return CredentialIdSchema.parse(result);
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  const result: unknown = await invoke('list_credentials');
  return CredentialSummaryListSchema.parse(result);
}

export async function getCredential(id: string): Promise<Credential> {
  const result: unknown = await invoke('get_credential', { id });
  return CredentialSchema.parse(result);
}

export async function updateCredential(id: string, input: CredentialInput): Promise<void> {
  await invoke('update_credential', { id, input });
}

export async function deleteCredential(id: string): Promise<void> {
  await invoke('delete_credential', { id });
}

/** Best-effort, non-leaking message from an IPC/command error. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
}
