// DEMO-ONLY: seed/remove the demo account. Reuses the PRODUCTION enrollment + TOTP
// services and repositories unchanged — the only "demo" parts are (a) creating a
// pre-fitted ACTIVE baseline by feeding the real enrollment lifecycle synthetic
// samples, and (b) flipping the freshly set-up TOTP secret to confirmed directly
// (no live authenticator round-trip). It changes NO scoring or policy.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, rmSync } from 'node:fs';

import type { Pool } from 'pg';

import type { ServerConfig } from '../config';
import { createDevicesRepository } from '../repositories/devices';
import { withTransaction } from '../repositories/pool';
import { createUsersRepository } from '../repositories/users';
import { createVaultItemsRepository } from '../repositories/vault-items';
import { createVaultKeysRepository } from '../repositories/vault-keys';
import { hashAuthKey } from '../services/auth-crypto';
import { createEnrollmentService } from '../services/enrollment';
import { createTotpService } from '../services/totp-service';
import { runCli, type RegistrationMaterial, type SealedBlob } from './cli';
import {
  DEMO_CREDENTIALS,
  DEMO_DEVICE_FINGERPRINT,
  DEMO_FEATURE_SCHEMA_VERSION,
  DEMO_MASTER_PASSWORD,
  DEMO_USERNAME,
  localVaultPath,
} from './env';
import { genuineBaselineSamples } from './samples';

export interface SeedResult {
  userId: string;
  username: string;
  masterPassword: string;
  baselineStatus: string;
  baselineSamples: number;
  totpSecret: string;
  provisioningUri: string;
  credentialCount: number;
  localVaultPath: string;
  localVaultCleared: boolean;
}

/**
 * Clear the desktop app's LOCAL vault file so the next unlock starts EMPTY and the
 * app reconstructs the vault from the server via the wired PULL-ON-UNLOCK (ADR-0008).
 * We no longer write seeded credentials into the local file directly — they live
 * server-side as encrypted blobs and arrive on unlock through the real sync path.
 * The local vault is a single per-machine file; any existing one is backed up to
 * `vault.json.bak` first (this simulates a fresh / reinstalled client).
 */
function clearLocalVault(): { path: string; cleared: boolean } {
  const path = localVaultPath();
  if (!existsSync(path)) {
    return { path, cleared: false };
  }
  copyFileSync(path, `${path}.bak`); // preserve any existing local vault
  rmSync(path, { force: true });
  return { path, cleared: true };
}

/**
 * Remove the demo account and everything it owns (idempotent), reset failure state,
 * and return the demoer's real device fingerprints so the seed can re-enroll them.
 */
export async function removeDemo(pool: Pool): Promise<{ removed: boolean; deviceFingerprints: string[] }> {
  const found = await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [DEMO_USERNAME]);
  const userId = found.rows[0]?.id;
  // Reset failure-velocity / brute-force-backstop state: the demoer's repeated failed
  // attempts raise login_failures by account AND by IP, so a by-user clear is not
  // enough — clear the recent window. Dev-only (a throwaway dev database).
  await pool.query("DELETE FROM login_failures WHERE occurred_at > now() - interval '24 hours'");
  if (userId === undefined) {
    return { removed: false, deviceFingerprints: [] };
  }
  // Preserve the demoer's REAL device fingerprints (recorded by prior login attempts)
  // so the re-seeded account treats their device as KNOWN — an unseen device would
  // otherwise push the login to step-up. The seed re-enrolls these after recreating
  // the user. risk_events.user_id is ON DELETE SET NULL, so delete those explicitly;
  // the rest (devices, sessions, totp, baseline, vault items) cascade from users.
  const devices = await pool.query<{ fingerprint_hash: string }>(
    'SELECT DISTINCT fingerprint_hash FROM devices WHERE user_id = $1',
    [userId],
  );
  await pool.query('DELETE FROM risk_events WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  return { removed: true, deviceFingerprints: devices.rows.map((r) => r.fingerprint_hash) };
}

/** Samples fitted into the demo keystroke baseline — enough for a well-conditioned,
 *  deliberately LOOSE covariance (so a real human login scores low → granted). */
const DEMO_BASELINE_SAMPLES = 20;

/** Create the ready-to-demo account (active baseline + confirmed TOTP + credentials). */
export async function seedDemo(pool: Pool, config: ServerConfig, preserveDevices: string[] = []): Promise<SeedResult> {
  // 1. Real client-side registration material (so the app can log in with the demo
  //    master password). Derived by the Rust oracle — same crypto as the app.
  const material = runCli<RegistrationMaterial>('register', { masterPassword: DEMO_MASTER_PASSWORD });

  // 2. Create the user + wrapped vault key (the server hashes the auth key, as in register).
  const userId = await withTransaction(pool, async (tx) => {
    const user = await createUsersRepository(tx).create({
      username: DEMO_USERNAME,
      authKeyHash: await hashAuthKey(material.authKey),
      kdfVersion: material.kdfVersion,
      kdfSalt: Buffer.from(material.kdfSalt, 'base64'),
      kdfParams: {
        memoryKib: material.kdfParams.memoryKib,
        iterations: material.kdfParams.iterations,
        parallelism: material.kdfParams.parallelism,
      },
    });
    await createVaultKeysRepository(tx).create({
      userId: user.id,
      wrappedVaultKey: Buffer.from(material.wrappedVaultKey, 'base64'),
      nonce: Buffer.from(material.wrappedVaultKeyNonce, 'base64'),
    });
    return user.id;
  });

  // 3. Drive a real ACTIVE keystroke baseline through the unmodified enrollment
  //    lifecycle, fitting from enough LOOSE samples for a well-conditioned covariance
  //    (independent of the env enrollment threshold, which is for real enrollers).
  const enrollment = createEnrollmentService({
    pool,
    baselineEncryptionKey: config.baselineEncryptionKey,
    minEnrollmentSamples: DEMO_BASELINE_SAMPLES,
  });
  const samples = genuineBaselineSamples(DEMO_BASELINE_SAMPLES);
  for (const features of samples) {
    await enrollment.submitSample(userId, { featureSchemaVersion: DEMO_FEATURE_SCHEMA_VERSION, features });
  }
  const status = await enrollment.getStatus(userId);

  // 4. Enroll the demo device AND re-enroll the demoer's real device fingerprints
  //    (preserved across the reset) so their login is on a KNOWN device → not escalated.
  const devices = createDevicesRepository(pool);
  await devices.enroll(userId, DEMO_DEVICE_FINGERPRINT);
  for (const fingerprint of preserveDevices) {
    if (fingerprint !== DEMO_DEVICE_FINGERPRINT) {
      await devices.enroll(userId, fingerprint);
    }
  }

  // 5. Set up a TOTP secret (production service), then CONFIRM it directly (demo).
  const totp = createTotpService({
    pool,
    encryptionKey: config.baselineEncryptionKey,
    config: config.policy.totp,
  });
  const setup = await totp.setup(userId);
  await pool.query('UPDATE totp_secrets SET confirmed = TRUE, last_used_step = NULL WHERE user_id = $1', [userId]);

  // 6. Seal a few example credentials with the demo vault key (Rust oracle) and store
  //    them as opaque server blobs (vault_items — ciphertext only). The app pulls
  //    these from the server on unlock (ADR-0008), so we do NOT write them locally.
  const items = createVaultItemsRepository(pool);
  for (const credential of DEMO_CREDENTIALS) {
    const blob = runCli<SealedBlob>('seal-credential', {
      masterPassword: DEMO_MASTER_PASSWORD,
      kdfSalt: material.kdfSalt,
      kdfParams: material.kdfParams,
      wrappedVaultKey: material.wrappedVaultKey,
      wrappedVaultKeyNonce: material.wrappedVaultKeyNonce,
      plaintext: JSON.stringify(credential),
    });
    await items.create({
      userId,
      id: randomUUID(),
      ciphertext: Buffer.from(blob.ciphertext, 'base64'),
      nonce: Buffer.from(blob.nonce, 'base64'),
      itemType: 'login',
    });
  }

  // 7. Clear the local vault so the next unlock pulls these server blobs fresh
  //    (simulating a clean / reinstalled client — the real multi-device path).
  const localVault = clearLocalVault();

  return {
    userId,
    username: DEMO_USERNAME,
    masterPassword: DEMO_MASTER_PASSWORD,
    baselineStatus: status.status,
    baselineSamples: status.samplesCollected,
    totpSecret: setup.secret,
    provisioningUri: setup.provisioningUri,
    credentialCount: DEMO_CREDENTIALS.length,
    localVaultPath: localVault.path,
    localVaultCleared: localVault.cleared,
  };
}

/** Print copy-pasteable login instructions for the operator (non-secret of value). */
export function printLoginNote(result: SeedResult): void {
  const line = '─'.repeat(68);
  console.log(`\n${line}`);
  console.log('  CERBERUS DEMO ACCOUNT — ready to log in (DEV ONLY)');
  console.log(line);
  console.log(`  Username         : ${result.username}`);
  console.log(`  Master password  : ${result.masterPassword}`);
  console.log(`  Behavioral base. : ${result.baselineStatus} (${String(result.baselineSamples)} samples)`);
  console.log(`  Credentials      : ${String(result.credentialCount)} seeded as encrypted server blobs (pulled on unlock)`);
  console.log(`  Local app vault  : ${result.localVaultCleared ? 'cleared — reconstructs from the server on unlock' : 'already empty/fresh'}`);
  console.log(`  TOTP secret      : ${result.totpSecret}`);
  console.log(`  TOTP otpauth URI : ${result.provisioningUri}`);
  console.log(line);
  console.log('  HOW TO DEMO:');
  console.log('   1. REMOVE any old "Cerberus:demo" entry from your authenticator, then add the');
  console.log('      FRESH secret/URI above — each seed/reset ROTATES it (old codes will fail).');
  console.log('   2. Start the server + app: `npm run dev:server` and `npm run dev:app`.');
  console.log(`   3. Log in as "${result.username}" with the master password above —`);
  console.log('      unlock PULLS the seeded credentials from the server into the vault.');
  console.log('   4. Force a behavioral step-up on cue: `npm run demo:impostor`,');
  console.log('      then complete the TOTP in the app. The Risk inspector (Research)');
  console.log('      panel then shows the scored events for this step-up session.');
  console.log(`${line}\n`);
}
