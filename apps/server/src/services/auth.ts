// Auth service — the zero-knowledge identity logic (PROJECT.md §1, §4.3; ADR-0001,
// ADR-0007). The server NEVER receives or stores the master password or any
// derived encryption key; it stores only an Argon2id hash of the auth key, the
// public KDF params, and the opaque wrapped vault key.
import { ARGON2ID_PARAMS, KDF_VERSION } from '@cerberus/protocol';
import type {
  KdfParams,
  LoginRequest,
  PreloginResponse,
  RegisterRequest,
} from '@cerberus/shared-types';
import type { Pool } from 'pg';

import type { ServerConfig } from '../config';
import { createDevicesRepository } from '../repositories/devices';
import { createLoginFailuresRepository } from '../repositories/login-failures';
import { withTransaction } from '../repositories/pool';
import { createSessionsRepository } from '../repositories/sessions';
import { createUsersRepository } from '../repositories/users';
import { createVaultKeysRepository } from '../repositories/vault-keys';
import {
  deterministicDummySalt,
  generateSessionToken,
  hashAuthKey,
  hashSessionToken,
  verifyAgainstDummy,
  verifyAuthKey,
} from './auth-crypto';
import { truncateIp } from './geoip';
import type { AccountLockout } from './rate-limiter';

/** Per-request login context (client IP for failure-velocity history). */
export interface LoginContext {
  ip: string | null;
}

export interface AuthServiceDeps {
  pool: Pool;
  config: ServerConfig;
  lockout: AccountLockout;
}

export type RegisterResult = { ok: true; userId: string } | { ok: false; reason: 'username_taken' };

export type LoginResult =
  | {
      ok: true;
      sessionToken: string;
      expiresAt: string;
      wrappedVaultKey: string;
      wrappedVaultKeyNonce: string;
      deviceIsNew: boolean;
    }
  | { ok: false };

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}

const DUMMY_KDF_PARAMS: KdfParams = {
  memoryKib: ARGON2ID_PARAMS.memoryKib,
  iterations: ARGON2ID_PARAMS.iterations,
  parallelism: ARGON2ID_PARAMS.parallelism,
};

export function createAuthService(deps: AuthServiceDeps) {
  const { pool, config, lockout } = deps;

  return {
    /** Register a new account. Returns the new user id, or `username_taken`. */
    async register(input: RegisterRequest): Promise<RegisterResult> {
      const authKeyHash = await hashAuthKey(input.authKey);

      try {
        const userId = await withTransaction(pool, async (tx) => {
          const created = await createUsersRepository(tx).create({
            username: input.username,
            authKeyHash,
            kdfVersion: input.kdfVersion,
            kdfSalt: Buffer.from(input.kdfSalt, 'base64'),
            kdfParams: input.kdfParams,
          });
          await createVaultKeysRepository(tx).create({
            userId: created.id,
            wrappedVaultKey: Buffer.from(input.wrappedVaultKey, 'base64'),
            nonce: Buffer.from(input.wrappedVaultKeyNonce, 'base64'),
          });
          return created.id;
        });
        return { ok: true, userId };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, reason: 'username_taken' };
        }
        throw error;
      }
    },

    /**
     * Return the KDF params the client needs to derive its auth key. For an
     * unknown username, return deterministic dummy params (ADR-0007) so present
     * and absent accounts are indistinguishable.
     */
    async prelogin(username: string): Promise<PreloginResponse> {
      const user = await createUsersRepository(pool).findByUsername(username);
      if (user) {
        return {
          kdfVersion: user.kdfVersion,
          kdfSalt: user.kdfSalt.toString('base64'),
          kdfParams: user.kdfParams,
        };
      }
      return {
        kdfVersion: KDF_VERSION,
        kdfSalt: deterministicDummySalt(config.enumerationSecret, username).toString('base64'),
        kdfParams: DUMMY_KDF_PARAMS,
      };
    },

    /**
     * Verify the auth key and, on success, enroll the device and issue a session.
     * The unknown-user and wrong-password paths perform the same Argon2id verify
     * work (no early return) so they are timing-indistinguishable.
     */
    async login(input: LoginRequest, context: LoginContext): Promise<LoginResult> {
      const user = await createUsersRepository(pool).findByUsername(input.username);

      let valid: boolean;
      if (user) {
        valid = await verifyAuthKey(user.authKeyHash, input.authKey);
      } else {
        // Equalize timing against the known-user path; result is always invalid.
        await verifyAgainstDummy(input.authKey);
        valid = false;
      }

      if (!user || !valid) {
        lockout.recordFailure(`acct:${input.username}`, Date.now());
        // Record the failure for the failure-velocity signal (ADR-0011). Only a
        // truncated IP + optional user_id — never the attempted password.
        await createLoginFailuresRepository(pool).record({
          userId: user?.id ?? null,
          ipTruncated: context.ip === null ? null : truncateIp(context.ip),
        });
        return { ok: false };
      }

      lockout.reset(`acct:${input.username}`);

      const vaultKey = await createVaultKeysRepository(pool).findByUserId(user.id);
      if (!vaultKey) {
        // A registered user always has a wrapped vault key; treat its absence as
        // a server-side inconsistency rather than leaking detail.
        throw new Error('vault key missing for user');
      }

      const sessionToken = generateSessionToken();
      const expiresAt = new Date(Date.now() + config.sessionTtlMs);

      const deviceIsNew = await withTransaction(pool, async (tx) => {
        const device = await createDevicesRepository(tx).enroll(
          user.id,
          input.deviceFingerprintHash,
        );
        await createSessionsRepository(tx).create({
          userId: user.id,
          deviceId: device.id,
          tokenHash: hashSessionToken(sessionToken),
          expiresAt,
          isNewDevice: device.isNew,
        });
        return device.isNew;
      });

      return {
        ok: true,
        sessionToken,
        expiresAt: expiresAt.toISOString(),
        wrappedVaultKey: vaultKey.wrappedVaultKey.toString('base64'),
        wrappedVaultKeyNonce: vaultKey.nonce.toString('base64'),
        deviceIsNew,
      };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
