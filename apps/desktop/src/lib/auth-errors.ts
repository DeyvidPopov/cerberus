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

/** The distinct, user-facing categories an auth attempt can fail into. */
export type AuthErrorKind =
  | 'invalid_credentials' // 401 — wrong username / master password (or wrong/expired step-up code)
  | 'access_denied' // 403 — risk policy denied the attempt (no detail, ever)
  | 'rate_limited' // 429 — absolute backstop tripped
  | 'network' // no HTTP response: server unreachable or a CSP block
  | 'unknown'; // anything else (e.g. an IPC/derivation error)

/**
 * Classify a thrown auth error into one distinct kind. An {@link ApiError} carries
 * the HTTP status; a transport failure (fetch rejects with a TypeError on a
 * network error or a CSP block) has no status and maps to `network`.
 */
export function classifyAuthError(error: unknown): AuthErrorKind {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 401:
        return 'invalid_credentials';
      case 403:
        return 'access_denied';
      case 429:
        return 'rate_limited';
      default:
        return 'unknown';
    }
  }
  // fetch() rejects with a TypeError when the request never reached a server
  // (offline, DNS failure, or a Content-Security-Policy connect-src block).
  if (error instanceof TypeError) {
    return 'network';
  }
  return 'unknown';
}

/** Messages for a failed LOGIN attempt. Static strings — no risk detail leaks. */
const LOGIN_MESSAGES: Record<AuthErrorKind, string> = {
  invalid_credentials: 'Incorrect username or master password',
  access_denied: 'Access denied due to risk',
  rate_limited: 'Too many attempts. Please wait and try again.',
  network: "Couldn't reach the server",
  unknown: 'Something went wrong. Please try again.',
};

/** Messages for a failed STEP-UP (TOTP) attempt. A 401 here means a bad/expired code. */
const STEP_UP_MESSAGES: Record<AuthErrorKind, string> = {
  invalid_credentials: 'Incorrect or expired code. Try again.',
  access_denied: 'Access denied due to risk',
  rate_limited: 'Too many attempts. Please wait and try again.',
  network: "Couldn't reach the server",
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
  if (error instanceof ApiError) {
    switch (error.status) {
      case 409:
        return 'That username is already taken. Try another one.';
      case 400:
        return 'Please check your username and password, then try again.';
      case 429:
        return 'Too many attempts. Please wait and try again.';
      default:
        return 'Something went wrong creating your vault. Please try again.';
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
