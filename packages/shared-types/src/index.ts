// The API/IPC contract — request/response shapes shared across the codebase
// (PROJECT.md §2). Defined once here as zod schemas (the single source of truth
// for both the static type AND the runtime validator) and imported by clients.
//
// These describe NON-SECRET shapes only: no keys or master password ever appear
// in a DTO (PROJECT.md §1, §4.2). Credential plaintext fields cross the IPC
// boundary by necessity (the UI must display them); they are never persisted to
// browser storage by the client.
import { z } from 'zod';

// Behavioral feature schema + enrollment DTOs (Milestone 6; ADR-0002, ADR-0009).
// Re-exported here so the contract has a single import surface (@cerberus/shared-types).
export * from './behavioral';
// Used directly below (the login request may carry a keystroke sample, ADR-0012).
import { EnrollmentSampleRequestSchema } from './behavioral';

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

/**
 * POST /auth/login — prove identity with the derived auth key. The optional
 * `keystrokeSample` is the position-indexed timing of the master-password entry
 * (durations only, never characters; ADR-0009) used for behavioral scoring at the
 * enforcement point (ADR-0012). The master password itself never crosses the wire.
 */
export const LoginRequestSchema = z.object({
  username: Username,
  authKey: Base64,
  /** Hash of the device fingerprint; the raw fingerprint never leaves the device. */
  deviceFingerprintHash: Base64,
  keystrokeSample: EnrollmentSampleRequestSchema.optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/** A TOTP / step-up code: 6–8 digits (RFC 6238). */
const OtpCode = z.string().regex(/^\d{6,8}$/u, 'must be a 6–8 digit code');

/** Login GRANTED — a full session was issued. */
export const GrantedLoginResponseSchema = z.object({
  status: z.literal('granted'),
  /** Opaque session token (the server stores only its hash). */
  sessionToken: z.string(),
  expiresAt: z.string(),
  /** The wrapped vault key, so a fresh client can unwrap it locally and unlock. */
  wrappedVaultKey: Base64,
  wrappedVaultKeyNonce: Base64,
  device: z.object({ isNew: z.boolean() }),
});
export type GrantedLoginResponse = z.infer<typeof GrantedLoginResponseSchema>;

/** Login requires STEP-UP — no session yet; satisfy the challenge with a TOTP code. */
export const StepUpRequiredResponseSchema = z.object({
  status: z.literal('step_up_required'),
  /** Opaque challenge handle (server stores only its hash); submit with the code. */
  challengeToken: z.string(),
  expiresAt: z.string(),
  methods: z.array(z.literal('totp')),
});
export type StepUpRequiredResponse = z.infer<typeof StepUpRequiredResponseSchema>;

/** Login outcome: granted (session) or step-up required. A deny is HTTP 403. */
export const LoginResponseSchema = z.discriminatedUnion('status', [
  GrantedLoginResponseSchema,
  StepUpRequiredResponseSchema,
]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** POST /auth/step-up/verify — complete a step-up with a TOTP code → a granted session. */
export const StepUpVerifyRequestSchema = z.object({
  challengeToken: z.string().min(1).max(256),
  code: OtpCode,
});
export type StepUpVerifyRequest = z.infer<typeof StepUpVerifyRequestSchema>;
export const StepUpVerifyResponseSchema = GrantedLoginResponseSchema;
export type StepUpVerifyResponse = z.infer<typeof StepUpVerifyResponseSchema>;

// --- TOTP enrollment (authenticated; ADR-0012) ---

/** POST /auth/totp/setup → a provisioning URI + base32 secret for an authenticator app. */
export const TotpSetupResponseSchema = z.object({
  provisioningUri: z.string(),
  secret: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;

/** POST /auth/totp/confirm — prove possession of the new secret with a first code. */
export const TotpConfirmRequestSchema = z.object({ code: OtpCode });
export type TotpConfirmRequest = z.infer<typeof TotpConfirmRequestSchema>;
export const TotpConfirmResponseSchema = z.object({ confirmed: z.boolean() });
export type TotpConfirmResponse = z.infer<typeof TotpConfirmResponseSchema>;

/** GET /auth/me — the authenticated session's identity (non-secret). */
export const SessionInfoSchema = z.object({
  userId: z.string(),
  deviceId: z.string().nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

// ---------------------------------------------------------------------------
// Encrypted blob sync (Milestone 5). ADR-0005 (wire format), ADR-0008 (sync).
//
// Every vault item is an OPAQUE AEAD blob (ADR-0005): the server stores and
// returns only ciphertext + non-secret metadata and never decrypts anything.
// `revision` drives optimistic concurrency (ADR-0008).
// ---------------------------------------------------------------------------

/** A UUID (exported for validating `:id` path params). */
export const UuidSchema = z.string().uuid();
const Uuid = UuidSchema;
/** A base64 byte string sized for credential ciphertext (larger than keys/nonces). */
const Base64Blob = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/u, 'must be base64').max(65536);

/** GET /vault/key — the wrapped vault key for fresh-client bootstrap. */
export const VaultKeyResponseSchema = z.object({
  wrappedVaultKey: Base64,
  wrappedVaultKeyNonce: Base64,
});
export type VaultKeyResponse = z.infer<typeof VaultKeyResponseSchema>;

/** A stored vault item (opaque blob + non-secret metadata). */
export const VaultItemSchema = z.object({
  id: Uuid,
  ciphertext: Base64Blob,
  nonce: Base64,
  itemType: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VaultItem = z.infer<typeof VaultItemSchema>;

/** GET /vault/items — the user's blobs (each with its metadata). */
export const VaultItemListSchema = z.array(VaultItemSchema);

/** POST /vault/items — store a new opaque blob (client supplies the id). */
export const CreateVaultItemRequestSchema = z.object({
  id: Uuid,
  ciphertext: Base64Blob,
  nonce: Base64,
  itemType: z.string().min(1).max(64).default('login'),
});
export type CreateVaultItemRequest = z.infer<typeof CreateVaultItemRequestSchema>;

/** PUT /vault/items/:id — replace a blob; `revision` is the base the edit was made on. */
export const UpdateVaultItemRequestSchema = z.object({
  ciphertext: Base64Blob,
  nonce: Base64,
  itemType: z.string().min(1).max(64).default('login'),
  revision: z.number().int().positive(),
});
export type UpdateVaultItemRequest = z.infer<typeof UpdateVaultItemRequestSchema>;

/** Result of a create/update: the id and the NEW revision. */
export const VaultMutationResponseSchema = z.object({
  id: Uuid,
  revision: z.number().int().positive(),
  updatedAt: z.string(),
});
export type VaultMutationResponse = z.infer<typeof VaultMutationResponseSchema>;

/** IPC result of `seal_credential` (an opaque AEAD blob). */
export const SealedBlobSchema = z.object({
  ciphertext: Base64Blob,
  nonce: Base64,
});
export type SealedBlob = z.infer<typeof SealedBlobSchema>;

/** IPC result of `open_credential` (the decrypted plaintext). */
export const PlaintextResultSchema = z.string();
