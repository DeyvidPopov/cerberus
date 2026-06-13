import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import {
  classifyAuthError,
  loginErrorMessage,
  registerErrorMessage,
  stepUpErrorMessage,
  type AuthErrorKind,
} from './auth-errors';

describe('classifyAuthError', () => {
  it('maps each HTTP status to a distinct kind', () => {
    expect(classifyAuthError(new ApiError(401, 'x'))).toBe('invalid_credentials');
    expect(classifyAuthError(new ApiError(403, 'x'))).toBe('access_denied');
    expect(classifyAuthError(new ApiError(429, 'x'))).toBe('rate_limited');
    expect(classifyAuthError(new ApiError(500, 'x'))).toBe('unknown');
  });

  it('maps a transport failure (fetch TypeError) to network', () => {
    expect(classifyAuthError(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('maps an unrecognized error (e.g. an IPC failure) to unknown', () => {
    expect(classifyAuthError('rust derivation failed')).toBe('unknown');
    expect(classifyAuthError(new Error('boom'))).toBe('unknown');
  });
});

describe('loginErrorMessage — each outcome renders a distinct message', () => {
  it('produces a different message for every kind', () => {
    const kinds: AuthErrorKind[] = [
      'invalid_credentials',
      'access_denied',
      'rate_limited',
      'network',
      'unknown',
    ];
    const errors: Record<AuthErrorKind, unknown> = {
      invalid_credentials: new ApiError(401, 'x'),
      access_denied: new ApiError(403, 'x'),
      rate_limited: new ApiError(429, 'x'),
      network: new TypeError('Failed to fetch'),
      unknown: new Error('x'),
    };
    const messages = kinds.map((k) => loginErrorMessage(errors[k]));
    expect(new Set(messages).size).toBe(kinds.length); // all distinct
  });

  it('uses the specified copy for 401 / 403 / network', () => {
    expect(loginErrorMessage(new ApiError(401, 'x'))).toBe('Incorrect username or master password');
    expect(loginErrorMessage(new ApiError(403, 'x'))).toBe('Access denied due to risk');
    expect(loginErrorMessage(new TypeError('Failed to fetch'))).toBe("Couldn't reach the server");
  });

  it('PRIVACY: a deny message leaks no risk detail', () => {
    // No signal names, scores, bands, or device/geo hints may appear.
    const msg = loginErrorMessage(new ApiError(403, 'denied'));
    expect(msg).not.toMatch(
      /keystroke|mouse|device|geo|velocity|score|band|signal|composite|behaviou?ral/iu,
    );
  });
});

describe('registerErrorMessage — distinct, non-leaking registration outcomes', () => {
  it('maps 409 to a clear "username taken" message (not the raw "request failed")', () => {
    const msg = registerErrorMessage(new ApiError(409, 'request to /auth/register failed'));
    expect(msg).toBe('That username is already taken. Try another one.');
    expect(msg).not.toContain('request to');
  });

  it('maps 400 / 429 / network / unknown to distinct messages', () => {
    expect(registerErrorMessage(new ApiError(400, 'x'))).toMatch(/check your username/i);
    expect(registerErrorMessage(new ApiError(429, 'x'))).toMatch(/too many attempts/i);
    expect(registerErrorMessage(new TypeError('Failed to fetch'))).toBe("Couldn't reach the server");
    expect(registerErrorMessage(new ApiError(500, 'x'))).toMatch(/something went wrong/i);
    expect(registerErrorMessage('rust derivation failed')).toMatch(/something went wrong/i);
  });

  it('never surfaces the raw postJson "request to /auth/register failed" string', () => {
    for (const status of [400, 409, 429, 500]) {
      expect(registerErrorMessage(new ApiError(status, 'request to /auth/register failed'))).not.toContain(
        'request to /auth/register failed',
      );
    }
  });
});

describe('stepUpErrorMessage', () => {
  it('treats a 401 as a bad/expired code (distinct from the login copy)', () => {
    expect(stepUpErrorMessage(new ApiError(401, 'x'))).toBe('Incorrect or expired code. Try again.');
    expect(stepUpErrorMessage(new ApiError(401, 'x'))).not.toBe(
      loginErrorMessage(new ApiError(401, 'x')),
    );
  });

  it('reports a transport failure distinctly from an auth failure', () => {
    expect(stepUpErrorMessage(new TypeError('x'))).toBe("Couldn't reach the server");
  });
});
