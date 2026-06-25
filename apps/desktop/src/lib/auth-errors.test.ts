import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { SecureCoreError } from './secure-core';
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
    // A server fault (5xx) is its OWN kind — distinct from an unexpected client error.
    expect(classifyAuthError(new ApiError(500, 'x'))).toBe('server_error');
    expect(classifyAuthError(new ApiError(503, 'x'))).toBe('server_error');
    expect(classifyAuthError(new ApiError(418, 'x'))).toBe('unknown'); // odd 4xx → unknown
  });

  it('maps a transport failure (fetch TypeError) to network', () => {
    expect(classifyAuthError(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('maps a local secure-core fault to its own kind (NOT network — the server is fine)', () => {
    // Both causes (bridge absent / command failed) classify the same — the remedy is local.
    expect(classifyAuthError(new SecureCoreError('unavailable'))).toBe('secure_core_unavailable');
    expect(classifyAuthError(new SecureCoreError('failed'))).toBe('secure_core_unavailable');
    expect(classifyAuthError(new SecureCoreError('unavailable'))).not.toBe('network');
  });

  it('maps an unrecognized error (e.g. an unexpected client error) to unknown', () => {
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
      'server_error',
      'network',
      'secure_core_unavailable',
      'unknown',
    ];
    const errors: Record<AuthErrorKind, unknown> = {
      invalid_credentials: new ApiError(401, 'x'),
      access_denied: new ApiError(403, 'x'),
      rate_limited: new ApiError(429, 'x'),
      server_error: new ApiError(500, 'x'),
      network: new TypeError('Failed to fetch'),
      secure_core_unavailable: new SecureCoreError('failed'),
      unknown: new Error('x'),
    };
    const messages = kinds.map((k) => loginErrorMessage(errors[k]));
    expect(new Set(messages).size).toBe(kinds.length); // all distinct
  });

  it('uses the specified copy for 401 / 403 / 5xx / network / secure-core', () => {
    expect(loginErrorMessage(new ApiError(401, 'x'))).toBe('Incorrect username or master password');
    expect(loginErrorMessage(new ApiError(403, 'x'))).toBe('Access denied due to risk');
    expect(loginErrorMessage(new TypeError('Failed to fetch'))).toBe("Couldn't reach the server");
    // The exact symptom that was reported: a server 500 now reads as a server fault,
    // not the indistinguishable "Something went wrong" client fallback.
    const five = loginErrorMessage(new ApiError(500, 'internal_error'));
    expect(five).toMatch(/server ran into a problem/i);
    expect(five).not.toBe('Something went wrong. Please try again.');
    // A local secure-core fault (the actual "Tester" symptom): a clear, distinct message
    // that points at the desktop runtime, NOT the generic "Something went wrong" or the
    // misleading "Couldn't reach the server".
    const core = loginErrorMessage(new SecureCoreError('failed'));
    expect(core).toMatch(/secure core/i);
    expect(core).toMatch(/desktop app/i);
    expect(core).not.toBe('Something went wrong. Please try again.');
    expect(core).not.toBe("Couldn't reach the server");
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
    expect(registerErrorMessage(new ApiError(500, 'x'))).toMatch(/server ran into a problem/i);
    expect(registerErrorMessage('rust derivation failed')).toMatch(/something went wrong/i);
  });

  it('maps a secure-core fault during registration to the desktop-runtime message', () => {
    const msg = registerErrorMessage(new SecureCoreError('unavailable'));
    expect(msg).toMatch(/secure core/i);
    expect(msg).toMatch(/desktop app/i);
    expect(msg).not.toMatch(/something went wrong/i);
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

  it('reports a secure-core fault distinctly from a transport failure', () => {
    const core = stepUpErrorMessage(new SecureCoreError('failed'));
    expect(core).toMatch(/secure core/i);
    expect(core).not.toBe("Couldn't reach the server");
  });
});

describe('PRIVACY: the secure-core message leaks no risk detail (ADR-0012/0015)', () => {
  it('names no signal, score, device, or location', () => {
    for (const msg of [
      loginErrorMessage(new SecureCoreError('failed')),
      registerErrorMessage(new SecureCoreError('unavailable')),
      stepUpErrorMessage(new SecureCoreError('failed')),
    ]) {
      expect(msg).not.toMatch(
        /keystroke|mouse|device|geo|velocity|score|band|signal|composite|behaviou?ral|location/iu,
      );
    }
  });
});
