import type { Db } from './pool';

export interface VaultKeyRecord {
  wrappedVaultKey: Buffer;
  nonce: Buffer;
}

export interface CreateVaultKeyInput {
  userId: string;
  wrappedVaultKey: Buffer;
  nonce: Buffer;
}

interface VaultKeyRow {
  wrapped_vault_key: Buffer;
  nonce: Buffer;
}

export function createVaultKeysRepository(db: Db) {
  return {
    async create(input: CreateVaultKeyInput): Promise<void> {
      await db.query(
        `INSERT INTO vault_keys (user_id, wrapped_vault_key, nonce)
         VALUES ($1, $2, $3)`,
        [input.userId, input.wrappedVaultKey, input.nonce],
      );
    },

    async findByUserId(userId: string): Promise<VaultKeyRecord | null> {
      const result = await db.query<VaultKeyRow>(
        `SELECT wrapped_vault_key, nonce FROM vault_keys WHERE user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      return row ? { wrappedVaultKey: row.wrapped_vault_key, nonce: row.nonce } : null;
    },
  };
}

export type VaultKeysRepository = ReturnType<typeof createVaultKeysRepository>;
