// Vault sync service (PROJECT.md §4.3; ADR-0005, ADR-0008). Business logic for
// the encrypted-blob sync API. Converts between the base64 wire form and the
// repository's Buffers; the server never decrypts. Authorization (user scoping)
// is enforced in the repository — this layer always passes the authenticated
// userId through.
import type {
  CreateVaultItemRequest,
  UpdateVaultItemRequest,
  VaultItem,
} from '@cerberus/shared-types';
import type { Pool } from 'pg';

import { createVaultItemsRepository, type VaultItemRecord } from '../repositories/vault-items';
import { createVaultKeysRepository } from '../repositories/vault-keys';

export interface VaultServiceDeps {
  pool: Pool;
}

export type CreateItemResult =
  | { ok: true; revision: number; updatedAt: string }
  | { ok: false; reason: 'conflict' };

export type UpdateItemResult =
  | { ok: true; revision: number; updatedAt: string }
  | { ok: false; reason: 'conflict' | 'not_found' };

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}

function toDto(record: VaultItemRecord): VaultItem {
  return {
    id: record.id,
    ciphertext: record.ciphertext.toString('base64'),
    nonce: record.nonce.toString('base64'),
    itemType: record.itemType,
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function createVaultService(deps: VaultServiceDeps) {
  const { pool } = deps;

  return {
    /** Fetch the wrapped vault key for fresh-client bootstrap. */
    async getVaultKey(
      userId: string,
    ): Promise<{ wrappedVaultKey: string; wrappedVaultKeyNonce: string } | null> {
      const key = await createVaultKeysRepository(pool).findByUserId(userId);
      if (!key) {
        return null;
      }
      return {
        wrappedVaultKey: key.wrappedVaultKey.toString('base64'),
        wrappedVaultKeyNonce: key.nonce.toString('base64'),
      };
    },

    async createItem(userId: string, input: CreateVaultItemRequest): Promise<CreateItemResult> {
      try {
        const { revision, updatedAt } = await createVaultItemsRepository(pool).create({
          userId,
          id: input.id,
          ciphertext: Buffer.from(input.ciphertext, 'base64'),
          nonce: Buffer.from(input.nonce, 'base64'),
          itemType: input.itemType,
        });
        return { ok: true, revision, updatedAt: updatedAt.toISOString() };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, reason: 'conflict' };
        }
        throw error;
      }
    },

    async listItems(userId: string): Promise<VaultItem[]> {
      const records = await createVaultItemsRepository(pool).listByUser(userId);
      return records.map(toDto);
    },

    async getItem(userId: string, id: string): Promise<VaultItem | null> {
      const record = await createVaultItemsRepository(pool).getForUser(userId, id);
      return record ? toDto(record) : null;
    },

    async updateItem(
      userId: string,
      id: string,
      input: UpdateVaultItemRequest,
    ): Promise<UpdateItemResult> {
      const outcome = await createVaultItemsRepository(pool).update({
        userId,
        id,
        ciphertext: Buffer.from(input.ciphertext, 'base64'),
        nonce: Buffer.from(input.nonce, 'base64'),
        itemType: input.itemType,
        expectedRevision: input.revision,
      });
      if (outcome.kind === 'updated') {
        return { ok: true, revision: outcome.revision, updatedAt: outcome.updatedAt.toISOString() };
      }
      return { ok: false, reason: outcome.kind };
    },

    async deleteItem(userId: string, id: string): Promise<boolean> {
      return createVaultItemsRepository(pool).deleteForUser(userId, id);
    },
  };
}

export type VaultService = ReturnType<typeof createVaultService>;
