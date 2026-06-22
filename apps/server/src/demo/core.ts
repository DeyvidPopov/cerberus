// DEMO-ONLY: seed/remove the demo account. Reuses the PRODUCTION enrollment + TOTP
// services and repositories unchanged — the only "demo" parts are (a) creating a
// pre-fitted ACTIVE baseline by feeding the real enrollment lifecycle synthetic
// samples, and (b) flipping the freshly set-up TOTP secret to confirmed directly
// (no live authenticator round-trip). It changes NO scoring or policy.
import { randomUUID } from 'node:crypto';

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
}

/** Remove the demo account and everything it owns (idempotent). */
export async function removeDemo(pool: Pool): Promise<boolean> {
  const found = await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [DEMO_USERNAME]);
  const userId = found.rows[0]?.id;
  if (userId === undefined) {
    return false;
  }
  // risk_events.user_id is ON DELETE SET NULL, so delete those rows explicitly to
  // leave no orphaned demo evaluations; the rest cascade from users.
  await pool.query('DELETE FROM risk_events WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  return true;
}

/** Create the ready-to-demo account (active baseline + confirmed TOTP + credentials). */
export async function seedDemo(pool: Pool, config: ServerConfig): Promise<SeedResult> {
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
  //    lifecycle: submit exactly the threshold many consistent synthetic samples.
  const threshold = config.behavioral.minEnrollmentSamples;
  const enrollment = createEnrollmentService({
    pool,
    baselineEncryptionKey: config.baselineEncryptionKey,
    minEnrollmentSamples: threshold,
  });
  const samples = genuineBaselineSamples(threshold);
  for (const features of samples) {
    await enrollment.submitSample(userId, { featureSchemaVersion: DEMO_FEATURE_SCHEMA_VERSION, features });
  }
  const status = await enrollment.getStatus(userId);

  // 4. Enroll the demo device as a KNOWN device (so a later login is not new-device).
  await createDevicesRepository(pool).enroll(userId, DEMO_DEVICE_FINGERPRINT);

  // 5. Set up a TOTP secret (production service), then CONFIRM it directly (demo).
  const totp = createTotpService({
    pool,
    encryptionKey: config.baselineEncryptionKey,
    config: config.policy.totp,
  });
  const setup = await totp.setup(userId);
  await pool.query('UPDATE totp_secrets SET confirmed = TRUE, last_used_step = NULL WHERE user_id = $1', [userId]);

  // 6. Seal a few example credentials with the demo vault key (Rust oracle) and
  //    store them as opaque AEAD blobs (the server only ever holds ciphertext).
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

  return {
    userId,
    username: DEMO_USERNAME,
    masterPassword: DEMO_MASTER_PASSWORD,
    baselineStatus: status.status,
    baselineSamples: status.samplesCollected,
    totpSecret: setup.secret,
    provisioningUri: setup.provisioningUri,
    credentialCount: DEMO_CREDENTIALS.length,
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
  console.log(`  Credentials      : ${String(result.credentialCount)} seeded (encrypted blobs)`);
  console.log(`  TOTP secret      : ${result.totpSecret}`);
  console.log(`  TOTP otpauth URI : ${result.provisioningUri}`);
  console.log(line);
  console.log('  HOW TO DEMO:');
  console.log('   1. Add the TOTP secret/URI above to an authenticator app.');
  console.log('   2. Start the server + app: `npm run dev:server` and `npm run dev:app`.');
  console.log(`   3. Log in as "${result.username}" with the master password above.`);
  console.log('   4. Force a behavioral step-up on cue: `npm run demo:impostor`,');
  console.log('      then complete the TOTP in the app. The Risk inspector (Research)');
  console.log('      panel then shows the scored events for this step-up session.');
  console.log(`${line}\n`);
}
