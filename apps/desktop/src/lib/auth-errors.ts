// User-facing classification of auth failures (Milestone 10, Part A).
//
// Since M9, /auth/login returns a DISCRIMINATED success (granted | step_up) plus
// distinct HTTP failures: 401 (bad auth key), 403 (risk deny), 429 (backstop), and
// a transport failure (network down / CSP block) that never produces an HTTP
// response at all. The desktop must render each outcome DISTINCTLY.
//
// PRIVACY (PROJECT.md §1, ADR-0012): the message must NOT leak which signal fired
// or any risk detail. A deny is a single generic "access denied" string — the
// server already withholds the reason (the risk_events row is server-side only).
import { ApiError } from './api';
import { SecureCoreError } from './secure-core';

/** The distinct, user-facing categories an auth attempt can fail into. */
export type AuthErrorKind =
  | 'invalid_credentials' // 401 — wrong username / master password (or wrong/expired step-up code)
  | 'access_denied' // 403 — risk policy denied the attempt (no detail, ever)
  | 'rate_limited' // 429 — absolute backstop tripped
  | 'server_error' // 5xx — the server faulted (NOT an auth outcome; e.g. a DB/migration error)
  | 'network' // no HTTP response: server unreachable or a CSP block
  | 'secure_core_unavailable' // the local Rust core/IPC bridge is absent or errored (NOT a server fault)
  | 'unknown'; // anything else (e.g. an unexpected client error)

/**
 * Classify a thrown auth error into one distinct kind. A {@link SecureCoreError}
 * (the local Rust core is unreachable, or its command failed) is its OWN kind —
 * distinct from `network`: the SERVER is fine, the problem is the desktop runtime.
 * An {@link ApiError} carries the HTTP status; a transport failure (fetch rejects
 * with a TypeError on a network error or a CSP block) has no status and maps to
 * `network`. A 5xx is a server fault (`server_error`) — distinct from a truly
 * unexpected `unknown`, so a backend problem (e.g. a 500 from an un-applied
 * migration) reads as such rather than as a vague client-side failure.
 */
export function classifyAuthError(error: unknown): AuthErrorKind {
  if (error instanceof SecureCoreError) {
    return 'secure_core_unavailable';
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'invalid_credentials';
    }
    if (error.status === 403) {
      return 'access_denied';
    }
    if (error.status === 429) {
      return 'rate_limited';
    }
    if (error.status >= 500) {
      return 'server_error';
    }
    return 'unknown';
  }
  // fetch() rejects with a TypeError when the request never reached a server
  // (offline, DNS failure, or a Content-Security-Policy connect-src block).
  if (error instanceof TypeError) {
    return 'network';
  }
  return 'unknown';
}

/** Generic, non-leaking copy for a server fault (5xx). Same across login/step-up/register. */
const SERVER_ERROR_MESSAGE = 'The server ran into a problem. Please try again in a moment.';

/**
 * Copy for a local secure-core fault. Distinct from the server/network copy on purpose:
 * it points at the DESKTOP runtime (open the app, restart it), which covers both causes
 * — the webview opened outside the app, and the Rust core erroring. Same across flows;
 * leaks no risk detail.
 */
const SECURE_CORE_MESSAGE =
  "Cerberus's secure core isn't responding. Make sure the Cerberus desktop app is running, then restart it and try again.";

/** Messages for a failed LOGIN attempt. Static strings — no risk detail leaks. */
const LOGIN_MESSAGES: Record<AuthErrorKind, string> = {
  invalid_credentials: 'Incorrect username or master password',
  access_denied: 'Access denied due to risk',
  rate_limited: 'Too many attempts. Please wait and try again.',
  server_error: SERVER_ERROR_MESSAGE,
  network: "Couldn't reach the server",
  secure_core_unavailable: SECURE_CORE_MESSAGE,
  unknown: 'Something went wrong. Please try again.',
};

/** Messages for a failed STEP-UP (TOTP) attempt. A 401 here means a bad/expired code. */
const STEP_UP_MESSAGES: Record<AuthErrorKind, string> = {
  invalid_credentials: 'Incorrect or expired code. Try again.',
  access_denied: 'Access denied due to risk',
  rate_limited: 'Too many attempts. Please wait and try again.',
  server_error: SERVER_ERROR_MESSAGE,
  network: "Couldn't reach the server",
  secure_core_unavailable: SECURE_CORE_MESSAGE,
  unknown: 'Something went wrong. Please try again.',
};

/** The message to show for a failed login. */
export function loginErrorMessage(error: unknown): string {
  return LOGIN_MESSAGES[classifyAuthError(error)];
}

/**
 * The message to show for a failed REGISTRATION. Registration has different HTTP
 * outcomes than login (notably 409 username-taken and 400 validation), so it maps
 * the status directly rather than through {@link classifyAuthError}. Previously any
 * non-2xx surfaced the raw `postJson` string ("request to /auth/register failed"),
 * which gave the user no idea what went wrong — most often a 409 (the username was
 * already taken, e.g. on a retry). These messages are non-leaking; "username taken"
 * is ordinary registration UX, not a risk-signal disclosure.
 */
export function registerErrorMessage(error: unknown): string {
  if (error instanceof SecureCoreError) {
    return SECURE_CORE_MESSAGE;
  }
  if (error instanceof ApiError) {
    switch (error.status) {
      case 409:
        return 'That username is already taken. Try another one.';
      case 400:
        return 'Please check your username and password, then try again.';
      case 429:
        return 'Too many attempts. Please wait and try again.';
      default:
        return error.status >= 500
          ? SERVER_ERROR_MESSAGE
          : 'Something went wrong creating your vault. Please try again.';
    }
  }
  if (error instanceof TypeError) {
    return "Couldn't reach the server";
  }
  return 'Something went wrong creating your vault. Please try again.';
}

/** The message to show for a failed step-up (TOTP) verification. */
export function stepUpErrorMessage(error: unknown): string {
  return STEP_UP_MESSAGES[classifyAuthError(error)];
}
