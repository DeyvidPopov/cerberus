// The API/IPC contract — request/response shapes shared across the codebase
// (PROJECT.md §2). Defined once here as zod schemas (the single source of truth
// for both the static type AND the runtime validator) and imported by clients.
//
// These describe NON-SECRET shapes only: no keys or master password ever appear
// in a DTO (PROJECT.md §1, §4.2). Credential plaintext fields cross the IPC
// boundary by necessity (the UI must display them); they are never persisted to
// browser storage by the client.
import { z } from 'zod';

/** Editable credential fields, sent to `add`/`update`. */
export const CredentialInputSchema = z.object({
  name: z.string(),
  username: z.string(),
  password: z.string(),
  url: z.string(),
  notes: z.string(),
});
export type CredentialInput = z.infer<typeof CredentialInputSchema>;

/** A list entry shown in the UI (no password). */
export const CredentialSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string(),
});
export type CredentialSummary = z.infer<typeof CredentialSummarySchema>;

/** A full credential returned by `get` (id + plaintext fields). */
export const CredentialSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string(),
  password: z.string(),
  url: z.string(),
  notes: z.string(),
});
export type Credential = z.infer<typeof CredentialSchema>;

/** Result of `list`: an array of summaries. */
export const CredentialSummaryListSchema = z.array(CredentialSummarySchema);

/** Result of `add`: the new credential's id. */
export const CredentialIdSchema = z.string();

// ---------------------------------------------------------------------------
// Identity & zero-knowledge login (Milestone 4). ADR-0001, ADR-0007.
//
// The server NEVER sees the master password or any derived encryption key. The
// client derives the auth key (ADR-0001) and sends only: the auth key, the
// public KDF params/salt, and the AEAD-wrapped vault key (opaque to the server).
// All byte fields cross the wire base64-encoded.
// ---------------------------------------------------------------------------

/** A base64-encoded byte string (with a sane max length to bound payloads). */
const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u, 'must be base64').max(4096);

/** A username: 3–64 chars, conservative charset. */
const Username = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/u, 'invalid username');

/** Argon2id cost parameters (public; ADR-0001). */
export const KdfParamsSchema = z.object({
  memoryKib: z.number().int().positive(),
  iterations: z.number().int().positive(),
  parallelism: z.number().int().positive(),
});
export type KdfParams = z.infer<typeof KdfParamsSchema>;

/** POST /auth/register — everything the server stores to enable later login. */
export const RegisterRequestSchema = z.object({
  username: Username,
  /** Argon2id+HKDF-derived auth key (the login proof). The server hashes it. */
  authKey: Base64,
  kdfVersion: z.number().int().positive(),
  kdfSalt: Base64,
  kdfParams: KdfParamsSchema,
  /** Vault key wrapped under the client's encryption key — opaque to the server. */
  wrappedVaultKey: Base64,
  wrappedVaultKeyNonce: Base64,
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({
  userId: z.string(),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

/**
 * The crypto material the Rust core returns for registration (IPC result): the
 * register request minus the username (which the UI supplies). Validated when it
 * crosses back from Rust (PROJECT.md §4.2).
 */
export const RegistrationMaterialSchema = RegisterRequestSchema.omit({ username: true });
export type RegistrationMaterial = z.infer<typeof RegistrationMaterialSchema>;

/** A base64 byte string returned across the IPC boundary (e.g. a derived auth key). */
export const Base64ResultSchema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u);

/** POST /auth/prelogin — fetch the KDF params needed to derive the auth key. */
export const PreloginRequestSchema = z.object({
  username: Username,
});
export type PreloginRequest = z.infer<typeof PreloginRequestSchema>;

/**
 * Prelogin response. For an UNKNOWN username the server returns plausible,
 * deterministic dummy params (ADR-0007) so the shape is indistinguishable from
 * a real account — the client cannot tell whether the account exists.
 */
export const PreloginResponseSchema = z.object({
  kdfVersion: z.number().int().positive(),
  kdfSalt: Base64,
  kdfParams: KdfParamsSchema,
});
export type PreloginResponse = z.infer<typeof PreloginResponseSchema>;

/** POST /auth/login — prove identity with the derived auth key. */
export const LoginRequestSchema = z.object({
  username: Username,
  authKey: Base64,
  /** Hash of the device fingerprint; the raw fingerprint never leaves the device. */
  deviceFingerprintHash: Base64,
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  /** Opaque session token (the server stores only its hash). */
  sessionToken: z.string(),
  expiresAt: z.string(),
  /** The wrapped vault key, so a fresh client can unwrap it locally and unlock. */
  wrappedVaultKey: Base64,
  wrappedVaultKeyNonce: Base64,
  device: z.object({
    isNew: z.boolean(),
  }),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** GET /auth/me — the authenticated session's identity (non-secret). */
export const SessionInfoSchema = z.object({
  userId: z.string(),
  deviceId: z.string().nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
