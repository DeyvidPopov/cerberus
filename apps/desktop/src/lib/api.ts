// HTTP API client for the Cerberus server (PROJECT.md §2 — lib/).
//
// Every server response is validated at runtime with the shared zod schemas
// before use — trust nothing across the network boundary (PROJECT.md §4.2). The
// client sends only the auth key, public KDF params, and the opaque wrapped vault
// key; the master password and encryption key never leave the Rust core.
import {
  LoginResponseSchema,
  PreloginResponseSchema,
  RegisterResponseSchema,
  type LoginRequest,
  type LoginResponse,
  type PreloginRequest,
  type PreloginResponse,
  type RegisterRequest,
  type RegisterResponse,
} from '@cerberus/shared-types';
import type { ZodType } from 'zod';

const DEFAULT_BASE_URL = 'http://localhost:8080';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function baseUrl(): string {
  const fromEnv: unknown = import.meta.env.VITE_API_BASE_URL;
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE_URL;
}

async function postJson<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, `request to ${path} failed`);
  }
  const json: unknown = await response.json();
  return schema.parse(json);
}

export async function register(req: RegisterRequest): Promise<RegisterResponse> {
  return postJson('/auth/register', req, RegisterResponseSchema);
}

export async function prelogin(req: PreloginRequest): Promise<PreloginResponse> {
  return postJson('/auth/prelogin', req, PreloginResponseSchema);
}

export async function login(req: LoginRequest): Promise<LoginResponse> {
  return postJson('/auth/login', req, LoginResponseSchema);
}
