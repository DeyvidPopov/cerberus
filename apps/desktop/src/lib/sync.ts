// Encrypted-blob sync orchestration (PROJECT.md §2 — lib/; ADR-0005, ADR-0008).
//
// Glue between the server API (HTTP) and the Rust crypto (IPC). The local
// encrypted vault is the source of truth; this reconciles it with the server.
// The master password is passed to Rust per operation and never persisted.
import { CredentialInputSchema, type CredentialInput, type KdfParams } from '@cerberus/shared-types';

import { createVaultItem, listVaultItems, updateVaultItem } from './api';
import { openCredential, sealCredential, type OpenArgs, type SealArgs } from './tauri';

/** Crypto context for a sync session (transient; not persisted to storage). */
export interface SyncContext {
  token: string;
  masterPassword: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  wrappedVaultKey: string;
  wrappedVaultKeyNonce: string;
}

export interface PulledItem {
  id: string;
  revision: number;
  data: CredentialInput;
}

function sealArgs(ctx: SyncContext, plaintext: string): SealArgs {
  return {
    masterPassword: ctx.masterPassword,
    kdfSalt: ctx.kdfSalt,
    kdfParams: ctx.kdfParams,
    wrappedVaultKey: ctx.wrappedVaultKey,
    wrappedVaultKeyNonce: ctx.wrappedVaultKeyNonce,
    plaintext,
  };
}

function openArgs(ctx: SyncContext, ciphertext: string, nonce: string): OpenArgs {
  return {
    masterPassword: ctx.masterPassword,
    kdfSalt: ctx.kdfSalt,
    kdfParams: ctx.kdfParams,
    wrappedVaultKey: ctx.wrappedVaultKey,
    wrappedVaultKeyNonce: ctx.wrappedVaultKeyNonce,
    ciphertext,
    nonce,
  };
}

/**
 * Pull on unlock: list the user's opaque blobs and decrypt each via Rust. The
 * caller has already fetched the wrapped vault key (bootstrap order:
 * login → GET vault key → unwrap → GET items → decrypt).
 */
export async function pullItems(ctx: SyncContext): Promise<PulledItem[]> {
  const items = await listVaultItems(ctx.token);
  const pulled: PulledItem[] = [];
  for (const item of items) {
    const plaintext = await openCredential(openArgs(ctx, item.ciphertext, item.nonce));
    pulled.push({
      id: item.id,
      revision: item.revision,
      data: CredentialInputSchema.parse(JSON.parse(plaintext)),
    });
  }
  return pulled;
}

/** Push a new credential: encrypt in Rust, store the opaque blob. Returns the revision. */
export async function pushNewItem(
  ctx: SyncContext,
  id: string,
  data: CredentialInput,
): Promise<number> {
  const sealed = await sealCredential(sealArgs(ctx, JSON.stringify(data)));
  const result = await createVaultItem(ctx.token, {
    id,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    itemType: 'login',
  });
  return result.revision;
}

/**
 * Push an edit using the revision the edit was based on. On a stale revision the
 * server returns 409 and `updateVaultItem` throws an `ApiError` (status 409) —
 * propagated here so the caller surfaces a conflict rather than overwriting
 * (ADR-0008). Returns the new revision on success.
 */
export async function pushUpdatedItem(
  ctx: SyncContext,
  id: string,
  data: CredentialInput,
  baseRevision: number,
): Promise<number> {
  const sealed = await sealCredential(sealArgs(ctx, JSON.stringify(data)));
  const result = await updateVaultItem(ctx.token, id, {
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    itemType: 'login',
    revision: baseRevision,
  });
  return result.revision;
}
