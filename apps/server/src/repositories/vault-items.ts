import type { Db } from './pool';

// Vault-item persistence (PROJECT.md §4.3). EVERY method is scoped to the
// authenticated user_id in its WHERE clause — authorization is enforced here, in
// the repository, not only in the route (defense against IDOR). The server stores
// and returns only opaque ciphertext + non-secret metadata; it never decrypts.

export interface VaultItemRecord {
  id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  itemType: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVaultItemInput {
  userId: string;
  id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  itemType: string;
}

export interface UpdateVaultItemInput {
  userId: string;
  id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  itemType: string;
  /** The revision the client based its edit on (optimistic concurrency). */
  expectedRevision: number;
}

export type UpdateOutcome =
  | { kind: 'updated'; revision: number; updatedAt: Date }
  | { kind: 'conflict' } // exists & owned, but revision mismatch
  | { kind: 'not_found' }; // absent or owned by another user

interface ItemRow {
  id: string;
  ciphertext: Buffer;
  nonce: Buffer;
  item_type: string;
  revision: string; // int8 comes back as string from node-pg
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: ItemRow): VaultItemRecord {
  return {
    id: row.id,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    itemType: row.item_type,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createVaultItemsRepository(db: Db) {
  return {
    /** Insert a new opaque blob owned by `userId` at revision 1. */
    async create(input: CreateVaultItemInput): Promise<{ revision: number; updatedAt: Date }> {
      const result = await db.query<{ revision: string; updated_at: Date }>(
        `INSERT INTO vault_items (id, user_id, ciphertext, nonce, item_type, revision)
         VALUES ($1, $2, $3, $4, $5, 1)
         RETURNING revision, updated_at`,
        [input.id, input.userId, input.ciphertext, input.nonce, input.itemType],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('vault item insert returned no row');
      }
      return { revision: Number(row.revision), updatedAt: row.updated_at };
    },

    /** List all of the user's blobs (scoped to user_id). */
    async listByUser(userId: string): Promise<VaultItemRecord[]> {
      const result = await db.query<ItemRow>(
        `SELECT id, ciphertext, nonce, item_type, revision, created_at, updated_at
         FROM vault_items
         WHERE user_id = $1
         ORDER BY created_at`,
        [userId],
      );
      return result.rows.map(toRecord);
    },

    /** Fetch one of the user's blobs by id (scoped to user_id; null if not owned). */
    async getForUser(userId: string, id: string): Promise<VaultItemRecord | null> {
      const result = await db.query<ItemRow>(
        `SELECT id, ciphertext, nonce, item_type, revision, created_at, updated_at
         FROM vault_items
         WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    /**
     * Optimistic-concurrency update (scoped to user_id). Bumps revision only when
     * the stored revision equals `expectedRevision`. Distinguishes a stale-revision
     * conflict from a not-found/not-owned item.
     */
    async update(input: UpdateVaultItemInput): Promise<UpdateOutcome> {
      const updated = await db.query<{ revision: string; updated_at: Date }>(
        `UPDATE vault_items
         SET ciphertext = $1, nonce = $2, item_type = $3, revision = revision + 1, updated_at = now()
         WHERE user_id = $4 AND id = $5 AND revision = $6
         RETURNING revision, updated_at`,
        [
          input.ciphertext,
          input.nonce,
          input.itemType,
          input.userId,
          input.id,
          input.expectedRevision,
        ],
      );
      const row = updated.rows[0];
      if (row) {
        return { kind: 'updated', revision: Number(row.revision), updatedAt: row.updated_at };
      }
      // No row updated: either revision mismatch (exists & owned) or not found/owned.
      const exists = await db.query<{ one: number }>(
        `SELECT 1 AS one FROM vault_items WHERE user_id = $1 AND id = $2`,
        [input.userId, input.id],
      );
      return exists.rows.length > 0 ? { kind: 'conflict' } : { kind: 'not_found' };
    },

    /** Delete one of the user's blobs (scoped to user_id). Returns whether a row was removed. */
    async deleteForUser(userId: string, id: string): Promise<boolean> {
      const result = await db.query(
        `DELETE FROM vault_items WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export type VaultItemsRepository = ReturnType<typeof createVaultItemsRepository>;
