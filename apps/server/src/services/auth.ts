// Auth service — zero-knowledge identity + ADAPTIVE enforcement (PROJECT.md §1,
// §4.3; ADR-0001, ADR-0007, ADR-0010..0012). The server NEVER receives the master
// password or any derived encryption key. M9: login is the ENFORCEMENT point — it
// verifies the auth key, evaluates the behavioral + contextual signals, combines
// them into a band, and grants / steps up / denies. A high absolute per-IP
// failed-login backstop replaces the M4 per-account lockout (no targeted DoS).
import { ARGON2ID_PARAMS, KDF_VERSION } from '@cerberus/protocol';
import type {
  EnrollmentSampleRequest,
  KdfParams,
  LoginRequest,
  PreloginResponse,
  RegisterRequest,
} from '@cerberus/shared-types';
import type { Pool } from 'pg';

import type { ServerConfig } from '../config';
import { createBehavioralBaselinesRepository } from '../repositories/behavioral-baselines';
import { createDevicesRepository } from '../repositories/devices';
import { createLoginFailuresRepository } from '../repositories/login-failures';
import { withTransaction } from '../repositories/pool';
import { createRiskEventsRepository } from '../repositories/risk-events';
import { createSessionsRepository } from '../repositories/sessions';
import { createStepUpChallengesRepository } from '../repositories/step-up-challenges';
import { createTotpSecretsRepository } from '../repositories/totp-secrets';
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
import type { EnrollmentService } from './enrollment';
import { truncateIp } from './geoip';
import type { BehavioralInput, RiskDecisionService } from './risk-decision';
import type { ScoringService } from './scoring';
import type { TotpService } from './totp-service';

/** Per-request login context (client IP for the backstop + failure history). */
export interface LoginContext {
  ip: string | null;
}

export interface AuthServiceDeps {
  pool: Pool;
  config: ServerConfig;
  riskDecision: RiskDecisionService;
  scoring: ScoringService;
  enrollment: EnrollmentService;
  totp: TotpService;
}

export type RegisterResult = { ok: true; userId: string } | { ok: false; reason: 'username_taken' };

interface GrantedSession {
  sessionToken: string;
  expiresAt: string;
  wrappedVaultKey: string;
  wrappedVaultKeyNonce: string;
  deviceIsNew: boolean;
}

export type LoginResult =
  | ({ kind: 'granted' } & GrantedSession)
  | { kind: 'step_up'; challengeToken: string; expiresAt: string }
  | { kind: 'denied' }
  | { kind: 'invalid_credentials' }
  | { kind: 'rate_limited'; retryAfterMs: number };

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
  const { pool, config, riskDecision, scoring, enrollment, totp } = deps;
  const backstop = config.policy.backstop;

  function windowStart(now: number): Date {
    return new Date(now - backstop.windowMinutes * 60_000);
  }

  /** Determine the behavioral sub-score; buffer the sample if the user is still enrolling. */
  async function behavioralFor(
    userId: string,
    sample: EnrollmentSampleRequest | null,
  ): Promise<BehavioralInput> {
    const active = await createBehavioralBaselinesRepository(pool).findActiveByUser(userId);
    if (active) {
      if (sample === null) {
        // Active baseline but no telemetry: FAIL CLOSED (suppression is not a bypass).
        return { score: 1, confidence: 'missing', reason: { status: 'missing_sample' } };
      }
      const result = await scoring.scoreActive(userId, sample);
      if (result.outcome === 'scored') {
        return {
          score: result.behavioralScore ?? 0,
          confidence: 'normal',
          reason: (result.keystroke.reason ?? {}) as Record<string, unknown>,
        };
      }
      // not_scored (dimension/schema mismatch) — fail closed.
      return { score: 1, confidence: 'missing', reason: (result.keystroke.reason ?? {}) as Record<string, unknown> };
    }
    // Enrolling: buffer the sample toward a baseline (best-effort); behavioral is cold-start neutral.
    if (sample !== null) {
      await enrollment.submitSample(userId, sample);
    }
    return { score: 0, confidence: 'low', reason: { status: 'enrolling' } };
  }

  async function issueSession(
    userId: string,
    deviceId: string | null,
    isNewDevice: boolean,
    stepUpConfirmed: boolean,
  ): Promise<({ kind: 'granted' } & GrantedSession)> {
    const vaultKey = await createVaultKeysRepository(pool).findByUserId(userId);
    if (!vaultKey) {
      throw new Error('vault key missing for user');
    }
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlMs);
    await createSessionsRepository(pool).create({
      userId,
      deviceId,
      tokenHash: hashSessionToken(sessionToken),
      expiresAt,
      isNewDevice,
      stepUpConfirmed,
    });
    return {
      kind: 'granted',
      sessionToken,
      expiresAt: expiresAt.toISOString(),
      wrappedVaultKey: vaultKey.wrappedVaultKey.toString('base64'),
      wrappedVaultKeyNonce: vaultKey.nonce.toString('base64'),
      deviceIsNew: isNewDevice,
    };
  }

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

    /** KDF params for deriving the auth key; deterministic dummy for unknown users (ADR-0007). */
    async prelogin(username: string): Promise<PreloginResponse> {
      const user = await createUsersRepository(pool).findByUsername(username);
      if (user) {
        return { kdfVersion: user.kdfVersion, kdfSalt: user.kdfSalt.toString('base64'), kdfParams: user.kdfParams };
      }
      return {
        kdfVersion: KDF_VERSION,
        kdfSalt: deterministicDummySalt(config.enumerationSecret, username).toString('base64'),
        kdfParams: DUMMY_KDF_PARAMS,
      };
    },

    /**
     * Verify the auth key and, on success, run the adaptive policy and enforce:
     * grant a session, require step-up (TOTP), or deny. A high absolute per-IP
     * failed-login backstop runs first (replaces the M4 per-account lockout).
     */
    async login(input: LoginRequest, context: LoginContext): Promise<LoginResult> {
      const now = Date.now();
      const ipTruncated = context.ip === null ? null : truncateIp(context.ip);
      const failures = createLoginFailuresRepository(pool);

      // Absolute per-IP backstop (hard) — only trips on extreme abuse from a source.
      if (ipTruncated !== null) {
        const ipFailures = await failures.countRecentByIp(ipTruncated, windowStart(now));
        if (ipFailures >= backstop.ipHardCap) {
          return { kind: 'rate_limited', retryAfterMs: backstop.windowMinutes * 60_000 };
        }
      }

      const user = await createUsersRepository(pool).findByUsername(input.username);
      let valid: boolean;
      if (user) {
        valid = await verifyAuthKey(user.authKeyHash, input.authKey);
      } else {
        await verifyAgainstDummy(input.authKey); // equalize timing
        valid = false;
      }
      if (!user || !valid) {
        await failures.record({ userId: user?.id ?? null, ipTruncated });
        return { kind: 'invalid_credentials' };
      }

      // Password verified: enroll the device, evaluate signals, decide, enforce.
      const device = await createDevicesRepository(pool).enroll(user.id, input.deviceFingerprintHash);
      const behavioral = await behavioralFor(user.id, input.keystrokeSample ?? null);
      const accountFailures = await failures.countRecentByUser(user.id, windowStart(now));
      const hasConfirmedTotp = await createTotpSecretsRepository(pool).hasConfirmed(user.id);

      const decision = await riskDecision.decide({
        userId: user.id,
        deviceId: device.id,
        isNewDevice: device.isNew,
        now: new Date(now),
        ip: context.ip,
        behavioral,
        hasConfirmedTotp,
        accountFailures,
      });

      await createRiskEventsRepository(pool).insert({
        userId: user.id,
        deviceId: device.id,
        signals: decision.signals,
        behavioralScore: decision.behavioralScore,
        contextScore: decision.contextScore,
        compositeScore: decision.compositeScore,
        policyBand: decision.band,
        actionTaken: decision.action,
        geoCountry: decision.geoCountry,
        geoRegion: decision.geoRegion,
        ipTruncated: decision.ipTruncated,
        outcome: decision.action,
      });

      if (decision.action === 'denied') {
        return { kind: 'denied' };
      }
      if (decision.action === 'step_up_required') {
        const challengeToken = generateSessionToken();
        const expiresAt = new Date(now + config.policy.totp.challengeTtlMs);
        await createStepUpChallengesRepository(pool).create({
          userId: user.id,
          tokenHash: hashSessionToken(challengeToken),
          deviceId: device.id,
          isNewDevice: device.isNew,
          method: 'totp',
          expiresAt,
        });
        return { kind: 'step_up', challengeToken, expiresAt: expiresAt.toISOString() };
      }
      // 'granted' or 'step_up_bootstrap_grant' (newcomer without a usable second factor).
      // Neither passed a TOTP step-up, so the session is NOT step-up-confirmed.
      return issueSession(user.id, device.id, device.isNew, false);
    },

    /**
     * Complete a step-up: verify the TOTP code against the pending challenge and
     * issue the session. A wrong code is recorded (feeds failure-velocity) but does
     * not consume the challenge, so a typo is retryable within the (rate-limited) TTL.
     */
    async verifyStepUp(
      input: { challengeToken: string; code: string },
      context: LoginContext,
    ): Promise<LoginResult> {
      const challenge = await createStepUpChallengesRepository(pool).findPendingByTokenHash(
        hashSessionToken(input.challengeToken),
      );
      if (!challenge) {
        return { kind: 'invalid_credentials' };
      }
      const result = await totp.verify(challenge.userId, input.code, Date.now());
      if (!result.ok) {
        await createLoginFailuresRepository(pool).record({
          userId: challenge.userId,
          ipTruncated: context.ip === null ? null : truncateIp(context.ip),
        });
        return { kind: 'invalid_credentials' };
      }
      // Atomically consume the challenge BEFORE issuing a session — if a concurrent
      // verify already consumed it, do not mint a second session (single-use).
      if (!(await createStepUpChallengesRepository(pool).consume(challenge.id, 'passed'))) {
        return { kind: 'invalid_credentials' };
      }
      // This session PASSED a TOTP step-up → mark it step-up-confirmed (gates /risk/events).
      return issueSession(challenge.userId, challenge.deviceId, challenge.isNewDevice, true);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
