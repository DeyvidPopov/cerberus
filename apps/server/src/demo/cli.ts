// DEMO-ONLY: a thin runner for the `cerberus-cli` client-crypto oracle (the SAME
// Rust crypto core the desktop app uses). The seed/impostor need real client-side
// derivation (Argon2id+HKDF) so the demo account's stored auth-key hash matches
// what the app derives at login — that crypto lives only in Rust, so we shell out
// to the dev/test oracle. NOT a production surface (cerberus-cli is never shipped).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/server/src/demo/ → repo root is four levels up.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const BIN = join(
  REPO_ROOT,
  'target',
  'debug',
  process.platform === 'win32' ? 'cerberus-cli.exe' : 'cerberus-cli',
);

const BUILD_HINT =
  'Build it once with:\n' +
  '  cargo build --bin cerberus-cli --manifest-path apps/desktop/src-tauri/Cargo.toml';

export function cliPath(): string {
  return BIN;
}

/** Run a cerberus-cli subcommand with a JSON request on stdin; parse the JSON reply. */
export function runCli<T>(command: string, input: unknown): T {
  if (!existsSync(BIN)) {
    throw new Error(`cerberus-cli not found at ${BIN}.\n${BUILD_HINT}`);
  }
  const result = spawnSync(BIN, [command], { input: JSON.stringify(input), encoding: 'utf8' });
  if (result.error) {
    throw new Error(`failed to run cerberus-cli ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`cerberus-cli ${command} exited ${String(result.status)}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout) as T;
}

export interface RegistrationMaterial {
  authKey: string;
  kdfVersion: number;
  kdfParams: { memoryKib: number; iterations: number; parallelism: number };
  kdfSalt: string;
  wrappedVaultKey: string;
  wrappedVaultKeyNonce: string;
}

export interface AuthKeyResult {
  authKey: string;
}

export interface SealedBlob {
  ciphertext: string;
  nonce: string;
}
