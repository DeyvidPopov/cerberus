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
  MergeOutcomeSchema,
  PlaintextResultSchema,
  RegistrationMaterialSchema,
  SealedBlobSchema,
  type Credential,
  type CredentialInput,
  type CredentialSummary,
  type KdfParams,
  type MergeOutcome,
  type RegistrationMaterial,
  type SealedBlob,
} from '@cerberus/shared-types';
import { invoke } from '@tauri-apps/api/core';

import { SecureCoreError, secureCoreAvailable } from './secure-core';

// Command-argument keys are camelCase. Tauri v2 deserializes invoke args with
// camelCase keys and maps them to the Rust commands' snake_case parameters
// (e.g. `masterPassword` → `master_password`); sending snake_case keys instead
// makes Tauri report a "missing required key" for the camelCase name. The Rust
// reply DTOs use `#[serde(rename_all = "camelCase")]`, so the validated reply
// shapes already match the shared zod schemas.

/**
 * Invoke a Rust command whose inputs are already validated, so it has NO domain-error
 * rejection — ANY failure is a secure-core fault. Both runtime failures become a typed
 * {@link SecureCoreError} the UI can render honestly (instead of an opaque string that
 * reads as a generic "Something went wrong", or a TypeError that masquerades as a
 * network error): the bridge being absent (not running in the desktop app) →
 * `'unavailable'`; the bridge present but the command rejecting/crashing → `'failed'`.
 * Use this ONLY for such commands — vault commands whose rejections are domain errors
 * (e.g. "vault is locked") must keep their message via `errorMessage`, not be wrapped.
 */
async function invokeSecureCore(command: string, args: Record<string, unknown>): Promise<unknown> {
  if (!secureCoreAvailable()) {
    throw new SecureCoreError('unavailable');
  }
  try {
    return await invoke(command, args);
  } catch (cause) {
    throw new SecureCoreError('failed', cause);
  }
}

/**
 * Derive registration material in Rust (auth key, KDF params, wrapped vault key).
 * The master password never leaves Rust; only non-key material is returned.
 */
export async function prepareRegistration(masterPassword: string): Promise<RegistrationMaterial> {
  const result = await invokeSecureCore('prepare_registration', { masterPassword });
  return RegistrationMaterialSchema.parse(result);
}

/** Derive the login auth key in Rust from the master password and KDF params. */
export async function deriveLoginAuthKey(
  masterPassword: string,
  kdfSalt: string,
  kdfParams: KdfParams,
): Promise<string> {
  const result = await invokeSecureCore('derive_login_auth_key_cmd', {
    masterPassword,
    kdfSalt,
    kdfParams,
  });
  return Base64ResultSchema.parse(result);
}

export interface SealArgs {
  masterPassword: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  wrappedVaultKey: string;
  wrappedVaultKeyNonce: string;
  plaintext: string;
}

/** Encrypt a credential to an opaque blob in Rust (for sync push). */
export async function sealCredential(args: SealArgs): Promise<SealedBlob> {
  const result: unknown = await invoke('seal_credential', {
    masterPassword: args.masterPassword,
    kdfSalt: args.kdfSalt,
    kdfParams: args.kdfParams,
    wrappedVaultKey: args.wrappedVaultKey,
    wrappedVaultKeyNonce: args.wrappedVaultKeyNonce,
    plaintext: args.plaintext,
  });
  return SealedBlobSchema.parse(result);
}

export interface OpenArgs {
  masterPassword: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  wrappedVaultKey: string;
  wrappedVaultKeyNonce: string;
  ciphertext: string;
  nonce: string;
}

/** Decrypt an opaque blob pulled from the server back to plaintext, in Rust. */
export async function openCredential(args: OpenArgs): Promise<string> {
  const result: unknown = await invoke('open_credential', {
    masterPassword: args.masterPassword,
    kdfSalt: args.kdfSalt,
    kdfParams: args.kdfParams,
    wrappedVaultKey: args.wrappedVaultKey,
    wrappedVaultKeyNonce: args.wrappedVaultKeyNonce,
    ciphertext: args.ciphertext,
    nonce: args.nonce,
  });
  return PlaintextResultSchema.parse(result);
}

/**
 * Open (or, on first run, initialize) the LOCAL vault for the account `vaultId` (its
 * username). The vault file is scoped to the account in the Rust core, so two accounts
 * on one machine each get their own vault and never collide — without scoping, a second
 * account hit the first's single vault file and failed to unwrap it, which surfaced as a
 * never-ending "vault is locked → log in to unlock" loop.
 */
export async function unlock(masterPassword: string, vaultId: string): Promise<void> {
  await invoke('unlock', { masterPassword, vaultId });
}

/** One encrypted server item to reconcile into the local vault (id + revision + blob). */
export interface ServerItem {
  id: string;
  revision: number;
  ciphertext: string;
  nonce: string;
}

export interface SyncPullArgs {
  masterPassword: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  /** The SERVER's wrapped vault key (from the granted login response). */
  wrappedVaultKey: string;
  wrappedVaultKeyNonce: string;
  items: ServerItem[];
}

/**
 * PULL on unlock: hand the server's encrypted items to Rust, which decrypts them
 * client-side (the server's wrapped vault key + master password → server vault key)
 * and merges them into the local vault, reconciled by revision. The plaintext never
 * crosses back to the webview; only non-secret counts return.
 */
export async function syncPullMerge(args: SyncPullArgs): Promise<MergeOutcome> {
  const result: unknown = await invoke('sync_pull_merge', {
    masterPassword: args.masterPassword,
    kdfSalt: args.kdfSalt,
    kdfParams: args.kdfParams,
    wrappedVaultKey: args.wrappedVaultKey,
    wrappedVaultKeyNonce: args.wrappedVaultKeyNonce,
    items: args.items,
  });
  return MergeOutcomeSchema.parse(result);
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
