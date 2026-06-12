import type { KdfParams } from '@cerberus/shared-types';

import type { Db } from './pool';

// The `users` row, as the rest of the server sees it (camelCase domain shape).
// The DB stores `kdf_params` JSONB in snake_case (per the schema comment); the
// mapping happens here so SQL/storage shape never leaks past the repository.
export interface UserRecord {
  id: string;
  username: string;
  authKeyHash: string;
  kdfVersion: number;
  kdfSalt: Buffer;
  kdfParams: KdfParams;
}

export interface CreateUserInput {
  username: string;
  authKeyHash: string;
  kdfVersion: number;
  kdfSalt: Buffer;
  kdfParams: KdfParams;
}

interface StoredKdfParams {
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

interface UserRow {
  id: string;
  username: string;
  auth_key_hash: string;
  kdf_version: number;
  kdf_salt: Buffer;
  kdf_params: StoredKdfParams;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    authKeyHash: row.auth_key_hash,
    kdfVersion: row.kdf_version,
    kdfSalt: row.kdf_salt,
    kdfParams: {
      memoryKib: row.kdf_params.memory_kib,
      iterations: row.kdf_params.iterations,
      parallelism: row.kdf_params.parallelism,
    },
  };
}

export function createUsersRepository(db: Db) {
  return {
    async create(input: CreateUserInput): Promise<{ id: string }> {
      const stored: StoredKdfParams = {
        memory_kib: input.kdfParams.memoryKib,
        iterations: input.kdfParams.iterations,
        parallelism: input.kdfParams.parallelism,
      };
      const result = await db.query<{ id: string }>(
        `INSERT INTO users (username, auth_key_hash, kdf_version, kdf_salt, kdf_params)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [input.username, input.authKeyHash, input.kdfVersion, input.kdfSalt, JSON.stringify(stored)],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('users insert returned no row');
      }
      return { id: row.id };
    },

    async findByUsername(username: string): Promise<UserRecord | null> {
      const result = await db.query<UserRow>(
        `SELECT id, username, auth_key_hash, kdf_version, kdf_salt, kdf_params
         FROM users
         WHERE username = $1`,
        [username],
      );
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    },

    async existsByUsername(username: string): Promise<boolean> {
      const result = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM users WHERE username = $1) AS exists`,
        [username],
      );
      return result.rows[0]?.exists ?? false;
    },
  };
}

export type UsersRepository = ReturnType<typeof createUsersRepository>;
