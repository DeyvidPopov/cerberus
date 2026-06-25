# Appendix D — Interface

This appendix reproduces, **verbatim**, the desktop webview (React + TypeScript,
shadcn/ui + Tailwind, ADR-0015): the auth screen and its distinct, non-leaking
login-outcome messages; the master-password input that feeds keystroke capture
plus its capture test; the behavioral-enrollment progress indicator; the TOTP
step-up component; and the continuous-auth spike→lock path. Each listing is the
exact file at the path in its heading.

## D.1 Auth screen & login outcomes

The entry screen (register / login / step-up prompt / spike-lock notice) and the
classifier mapping every failure to a distinct, risk-detail-free message.

### `apps/desktop/src/features/auth/AuthScreen.tsx`

````tsx
import type { EnrollmentStatus, GrantedLoginResponse } from '@cerberus/shared-types';
import { useState } from 'react';

import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { EyeIcon, EyeOffIcon, ShieldCheckIcon } from '../../components/icons';
import { getEnrollmentStatus } from '../../lib/api';
import { loginErrorMessage, registerErrorMessage, stepUpErrorMessage } from '../../lib/auth-errors';
import { completeStepUp, loginAccount, registerAccount } from '../../lib/auth';
import { useKeystrokeCapture } from '../../lib/keystroke-capture';
import { AuthFrame } from './AuthFrame';

/** What a completed auth hands up: the session token and (on login) enrollment progress. */
export interface AuthenticatedSession {
  token: string | null;
  enrollment: EnrollmentStatus | null;
}

/** Why the unlock screen was shown again. 'risk' ⇒ a continuous-auth spike locked the vault. */
export type LockReason = 'risk' | null;

interface AuthScreenProps {
  onAuthenticated: (session: AuthenticatedSession) => void;
  /** PRESENTATION ONLY: show a calm "locked for your security" notice on re-unlock. */
  lockNotice?: LockReason;
}

type Mode = 'login' | 'register';

// Entry screen. The master password lives in component state only until handed to
// the Rust derivation, then cleared (PROJECT.md §4.2). The password input's
// KEYSTROKE TIMING (positions only, never characters — see lib/keystroke) is
// captured during login and sent WITH the login request; the server runs the
// adaptive policy (ADR-0012). The password value still flows only to Rust.
//
// M12 is a PRESENTATION restyle (ADR-0015): the master-password <Input> forwards
// its ref to a real <input>, so keystroke capture attaches exactly as before, and
// every outcome message is the unchanged M10 generic copy (no risk detail leaks).
export function AuthScreen({ onAuthenticated, lockNotice = null }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  // When a login bands to step_up, hold the challenge until the TOTP code is entered.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const capture = useKeystrokeCapture();

  const clearSecrets = (): void => {
    setPassword('');
    setConfirm('');
    setTotpCode('');
  };

  const finishGranted = async (session: GrantedLoginResponse): Promise<void> => {
    let enrollment: EnrollmentStatus | null = null;
    try {
      enrollment = await getEnrollmentStatus(session.sessionToken);
    } catch {
      enrollment = null; // best-effort; never block the unlock
    }
    setChallengeToken(null);
    clearSecrets();
    onAuthenticated({ token: session.sessionToken, enrollment });
  };

  const doRegister = async (): Promise<void> => {
    await registerAccount(username, password);
    capture.reset();
    clearSecrets();
    onAuthenticated({ token: null, enrollment: null });
  };

  const doLogin = async (): Promise<void> => {
    // The captured keystroke timing is sent with the login request itself.
    const features = capture.takeSample();
    const outcome = await loginAccount(username, password, features);
    if (outcome.kind === 'granted') {
      await finishGranted(outcome.session);
    } else {
      // Step-up required: keep the challenge and prompt for a TOTP code.
      setChallengeToken(outcome.challengeToken);
      clearSecrets();
    }
  };

  const doStepUp = async (): Promise<void> => {
    if (challengeToken === null) {
      return;
    }
    const session = await completeStepUp({ challengeToken, code: totpCode });
    await finishGranted(session);
  };

  // Each action supplies its own error→message mapping so every outcome renders a
  // DISTINCT, non-leaking message (ADR-0012): login maps 401/403/429/network
  // separately; step-up reads a 401 as a bad code; register maps 409 (username
  // taken) / 400 / network distinctly instead of the raw "request failed" string.
  const run = (action: () => Promise<void>, mapError: (e: unknown) => string): void => {
    setError(null);
    setBusy(true);
    void action()
      .catch((e: unknown) => {
        capture.reset();
        clearSecrets();
        setError(mapError(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const submit = (): void => {
    if (mode === 'register' && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (mode === 'register') {
      run(doRegister, registerErrorMessage);
    } else {
      run(doLogin, loginErrorMessage);
    }
  };

  const toggleMode = (): void => {
    setMode((current) => (current === 'login' ? 'register' : 'login'));
    setError(null);
    setChallengeToken(null);
    setShowPw(false);
    capture.reset();
    clearSecrets();
  };

  // A password field with a show/hide affordance. `inputRef` (when given) is the
  // keystroke-capture ref — it must reach the real <input> (Input forwards it).
  const passwordField = (opts: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    autoComplete: string;
    inputRef?: (el: HTMLInputElement | null) => void;
    valid?: boolean;
  }) => (
    <Field label={opts.label}>
      <div className="relative">
        <Input
          ref={opts.inputRef}
          type={showPw ? 'text' : 'password'}
          aria-label={opts.label}
          placeholder="••••••••••••"
          autoComplete={opts.autoComplete}
          className={opts.valid ? 'border-ok/40 pr-11 font-mono' : 'pr-11 font-mono'}
          value={opts.value}
          onChange={(e) => {
            opts.onChange(e.target.value);
          }}
          disabled={busy}
        />
        <button
          type="button"
          aria-label={showPw ? 'Hide password' : 'Show password'}
          onClick={() => {
            setShowPw((s) => !s);
          }}
          className="absolute right-1.5 top-1.5 flex h-[34px] w-[34px] items-center justify-center rounded-lg text-muted2 hover:text-fg"
        >
          {showPw ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
        </button>
      </div>
    </Field>
  );

  // STEP-UP — a focused, reassuring prompt (info tone), not an error.
  if (challengeToken !== null) {
    return (
      <AuthFrame>
        <div className="text-center">
          <div className="mx-auto flex h-[54px] w-[54px] items-center justify-center rounded-[15px] border border-accent/30 bg-accent/[0.12] text-accent">
            <ShieldCheckIcon size={26} />
          </div>
          <h1 className="mt-[18px] font-display text-2xl font-semibold tracking-[-0.02em]">
            Additional verification needed
          </h1>
          <p className="mx-auto mt-2 max-w-[300px] text-[13.5px] leading-[1.55] text-muted">
            Please confirm it&rsquo;s you. Enter the 6-digit code from your authenticator app.
          </p>
        </div>
        <form
          className="mt-6"
          onSubmit={(e) => {
            e.preventDefault();
            run(doStepUp, stepUpErrorMessage);
          }}
        >
          <Input
            aria-label="Authenticator code"
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            className="text-center font-mono text-xl tracking-[0.5em]"
            value={totpCode}
            onChange={(e) => {
              setTotpCode(e.target.value);
            }}
            disabled={busy}
          />
          {error !== null && <Banner className="mt-4" tone="error" title={error} />}
          <Button type="submit" className="mt-5 w-full" disabled={busy || totpCode.length < 6}>
            {busy ? 'Verifying…' : 'Verify'}
          </Button>
        </form>
        <button
          type="button"
          onClick={() => {
            setChallengeToken(null);
            setError(null);
          }}
          disabled={busy}
          className="mt-4 block w-full text-center text-[13px] text-muted2 hover:text-fg disabled:opacity-50"
        >
          Use a different account
        </button>
      </AuthFrame>
    );
  }

  const isRegister = mode === 'register';
  const confirmValid = isRegister && confirm.length > 0 && confirm === password;

  return (
    <AuthFrame>
      <h1 className="font-display text-[25px] font-semibold tracking-[-0.02em]">
        {isRegister ? 'Create your vault' : 'Unlock your vault'}
      </h1>
      <p className="mt-[7px] text-[13.5px] leading-[1.5] text-muted">
        {isRegister
          ? "One master password unlocks everything. Make it strong — we can't recover it."
          : 'Welcome back. Enter your master password to continue.'}
      </p>

      {/* Continuous-auth spike-lock notice (presentation only; generic copy). */}
      {!isRegister && lockNotice === 'risk' && (
        <Banner className="mt-5" tone="info" title="Locked for your security">
          Please unlock again to continue. Your credentials stayed encrypted and safe.
        </Banner>
      )}

      {error !== null && <Banner className="mt-5" tone="error" title={error} />}

      <form
        className="mt-[22px] flex flex-col gap-[15px]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Username">
          <Input
            aria-label="Username"
            placeholder="you"
            autoComplete="username"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
            disabled={busy}
          />
        </Field>

        {passwordField({
          label: 'Master password',
          value: password,
          onChange: setPassword,
          autoComplete: isRegister ? 'new-password' : 'current-password',
          inputRef: capture.inputRef,
        })}

        {isRegister &&
          passwordField({
            label: 'Confirm master password',
            value: confirm,
            onChange: setConfirm,
            autoComplete: 'new-password',
            valid: confirmValid,
          })}

        <Button
          type="submit"
          className="mt-1.5 w-full"
          disabled={busy || username.length === 0 || password.length === 0}
        >
          {busy ? (isRegister ? 'Creating vault…' : 'Logging in…') : isRegister ? 'Create vault' : 'Log in'}
        </Button>
      </form>

      <div className="mt-[18px] text-center text-[13px] text-muted2">
        {isRegister ? 'Have an account? ' : 'New here? '}
        <button type="button" onClick={toggleMode} disabled={busy} className="font-medium text-accent-hi hover:underline">
          {isRegister ? 'Log in' : 'Create a vault'}
        </button>
      </div>
    </AuthFrame>
  );
}
````

### `apps/desktop/src/lib/auth-errors.ts`

````typescript
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
  | 'server_error' // 5xx — the server faulted (NOT an auth outcome; e.g. a DB/migration error)
  | 'network' // no HTTP response: server unreachable or a CSP block
  | 'unknown'; // anything else (e.g. an IPC/derivation error)

/**
 * Classify a thrown auth error into one distinct kind. An {@link ApiError} carries
 * the HTTP status; a transport failure (fetch rejects with a TypeError on a
 * network error or a CSP block) has no status and maps to `network`. A 5xx is a
 * server fault (`server_error`) — distinct from a truly unexpected `unknown`, so a
 * backend problem (e.g. a 500 from an un-applied migration) reads as such rather
 * than as a vague client-side failure.
 */
export function classifyAuthError(error: unknown): AuthErrorKind {
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

/** Messages for a failed LOGIN attempt. Static strings — no risk detail leaks. */
const LOGIN_MESSAGES: Record<AuthErrorKind, string> = {
  invalid_credentials: 'Incorrect username or master password',
  access_denied: 'Access denied due to risk',
  rate_limited: 'Too many attempts. Please wait and try again.',
  server_error: SERVER_ERROR_MESSAGE,
  network: "Couldn't reach the server",
  unknown: 'Something went wrong. Please try again.',
};

/** Messages for a failed STEP-UP (TOTP) attempt. A 401 here means a bad/expired code. */
const STEP_UP_MESSAGES: Record<AuthErrorKind, string> = {
  invalid_credentials: 'Incorrect or expired code. Try again.',
  access_denied: 'Access denied due to risk',
  rate_limited: 'Too many attempts. Please wait and try again.',
  server_error: SERVER_ERROR_MESSAGE,
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
````

## D.2 Master-password input → keystroke capture (+ capture test)

The hook that attaches capture to the password `<input>`, the position-indexed
recorder/extractor it drives (durations only — never character identity), and the
capture test (including the privacy trap proving key identity is never read).

### `apps/desktop/src/lib/keystroke-capture.ts`

````typescript
// React hook wiring keystroke capture onto an input (Milestone 6).
//
// Returns a ref callback to put on the master-password input and `takeSample` to
// read the position-indexed vector after a successful login. The hook holds only
// timing (in the recorder); it never holds the password or any character.
import { useCallback, useRef } from 'react';

import { attachKeystrokeCapture, KeystrokeRecorder } from './keystroke';

export interface KeystrokeCapture {
  /** Ref callback for the input whose keystroke timing is captured. */
  inputRef: (element: HTMLInputElement | null) => void;
  /** Extract the captured feature vector (durations only) and reset, or null. */
  takeSample: () => number[] | null;
  /** Discard captured timing without extracting. */
  reset: () => void;
}

export function useKeystrokeCapture(): KeystrokeCapture {
  const recorderRef = useRef<KeystrokeRecorder>(new KeystrokeRecorder());
  const detachRef = useRef<(() => void) | null>(null);

  const inputRef = useCallback((element: HTMLInputElement | null): void => {
    detachRef.current?.();
    detachRef.current = null;
    if (element !== null) {
      detachRef.current = attachKeystrokeCapture(element, recorderRef.current);
    }
  }, []);

  const takeSample = useCallback((): number[] | null => {
    const vector = recorderRef.current.extract();
    recorderRef.current.reset();
    return vector;
  }, []);

  const reset = useCallback((): void => {
    recorderRef.current.reset();
  }, []);

  return { inputRef, takeSample, reset };
}
````

### `apps/desktop/src/lib/keystroke.ts`

````typescript
// Position-indexed keystroke capture (Milestone 6). ADR-0002, ADR-0009.
//
// THE PRIVACY RULE, enforced structurally: this module records only event TYPE
// (keydown vs keyup, via separate listeners) and TIMESTAMPS. It never reads
// `event.key`, `event.code`, `event.keyCode`, or any character identity — the
// recorder's API has no parameter that could carry one. The master password
// flows ONLY to the Rust crypto core (unchanged); this timing path is separate
// and produces durations alone.
import { extractFeatureVector, MIN_KEYSTROKES, type KeystrokeTiming } from '@cerberus/shared-types';

const defaultNow = (): number => performance.now();

interface Entry {
  down: number;
  up: number | null;
}

/**
 * Accumulates keydown/keyup TIMESTAMPS by keystroke position and extracts the
 * position-indexed feature vector. Keyups are matched to keydowns in FIFO press
 * order (correct for deliberate password entry; under rare nested-release
 * rollover the attribution is approximate — documented in ADR-0009). No method
 * accepts a key or character: identity cannot enter here.
 */
export class KeystrokeRecorder {
  private entries: Entry[] = [];
  private pending: number[] = [];

  /** Record a keydown at `timestamp` (ms). Advances the position counter. */
  recordDown(timestamp: number): void {
    const position = this.entries.length;
    this.entries.push({ down: timestamp, up: null });
    this.pending.push(position);
  }

  /** Record a keyup at `timestamp` (ms), matched to the oldest unreleased keydown. */
  recordUp(timestamp: number): void {
    const position = this.pending.shift();
    if (position === undefined) {
      return; // stray keyup (e.g. a key pressed before capture began)
    }
    const entry = this.entries[position];
    if (entry !== undefined) {
      entry.up = timestamp;
    }
  }

  /** Discard all captured timing (call between attempts / on field clear). */
  reset(): void {
    this.entries = [];
    this.pending = [];
  }

  /** Number of keydowns captured so far. */
  get length(): number {
    return this.entries.length;
  }

  /** Whether enough keystrokes are captured and all have been released. */
  isComplete(): boolean {
    return this.entries.length >= MIN_KEYSTROKES && this.entries.every((e) => e.up !== null);
  }

  /**
   * Extract the position-indexed feature vector (durations only), or null if the
   * capture is incomplete (too few keys, or a key never released).
   */
  extract(): number[] | null {
    if (this.entries.length < MIN_KEYSTROKES) {
      return null;
    }
    const timings: KeystrokeTiming[] = [];
    for (const entry of this.entries) {
      if (entry.up === null) {
        return null;
      }
      timings.push({ down: entry.down, up: entry.up });
    }
    return extractFeatureVector(timings);
  }
}

/**
 * The minimal event shape this module reads: ONLY `repeat` (to drop key-repeat
 * keydowns), and it is optional. No `key`/`code`/`keyCode` — by construction the
 * capture handler cannot observe character identity. `readonly repeat?: boolean`
 * makes a real DOM `KeyboardEvent` structurally assignable here.
 */
export interface KeystrokeProbeEvent {
  readonly repeat?: boolean;
}

/** A target the capture can attach to (a real `HTMLInputElement` satisfies this). */
export interface KeystrokeCaptureTarget {
  addEventListener(type: 'keydown' | 'keyup', listener: (event: KeystrokeProbeEvent) => void): void;
  removeEventListener(
    type: 'keydown' | 'keyup',
    listener: (event: KeystrokeProbeEvent) => void,
  ): void;
}

/**
 * Attach keydown/keyup capture to an input. Returns a detach function. The
 * handlers read only `event.repeat` and the clock — never the typed character.
 */
export function attachKeystrokeCapture(
  target: KeystrokeCaptureTarget,
  recorder: KeystrokeRecorder,
  now: () => number = defaultNow,
): () => void {
  const onDown = (event: KeystrokeProbeEvent): void => {
    if (event.repeat === true) {
      return; // ignore auto-repeat; it is not a fresh keystroke
    }
    recorder.recordDown(now());
  };
  const onUp = (): void => {
    recorder.recordUp(now());
  };
  target.addEventListener('keydown', onDown);
  target.addEventListener('keyup', onUp);
  return () => {
    target.removeEventListener('keydown', onDown);
    target.removeEventListener('keyup', onUp);
  };
}
````

### `apps/desktop/src/lib/keystroke.test.ts`

````typescript
import { describe, expect, it } from 'vitest';

import {
  KeystrokeRecorder,
  attachKeystrokeCapture,
  type KeystrokeCaptureTarget,
  type KeystrokeProbeEvent,
} from './keystroke';

describe('KeystrokeRecorder — position-indexed timing', () => {
  it('extracts the correct vector from down/up events', () => {
    const r = new KeystrokeRecorder();
    // Three keys: downs 100/200/300, ups 180/260/400.
    r.recordDown(100);
    r.recordUp(180);
    r.recordDown(200);
    r.recordUp(260);
    r.recordDown(300);
    r.recordUp(400);
    // holds 80/60/100 ; DD 100/100 ; UD 20/40
    expect(r.extract()).toEqual([80, 60, 100, 100, 100, 20, 40]);
  });

  it('matches keyups to keydowns in FIFO order under release-ordered rollover', () => {
    const r = new KeystrokeRecorder();
    // key0 down 100, key1 down 190 (before key0 up), key0 up 200, key1 up 250.
    r.recordDown(100);
    r.recordDown(190);
    r.recordUp(200); // → key0
    r.recordUp(250); // → key1
    // holds: 100, 60 ; DD: 90 ; UD: 190-200 = -10
    expect(r.extract()).toEqual([100, 60, 90, -10]);
  });

  it('returns null while capture is incomplete (a key not yet released)', () => {
    const r = new KeystrokeRecorder();
    r.recordDown(0);
    r.recordUp(50);
    r.recordDown(100); // never released
    expect(r.isComplete()).toBe(false);
    expect(r.extract()).toBeNull();
  });

  it('reset() discards captured timing', () => {
    const r = new KeystrokeRecorder();
    r.recordDown(0);
    r.recordUp(10);
    r.recordDown(20);
    r.recordUp(30);
    r.reset();
    expect(r.length).toBe(0);
    expect(r.extract()).toBeNull();
  });

  it('PRIVACY: the extracted vector is numbers only — no character identity', () => {
    const r = new KeystrokeRecorder();
    r.recordDown(0);
    r.recordUp(10);
    r.recordDown(20);
    r.recordUp(30);
    const v = r.extract();
    expect(v).not.toBeNull();
    expect(v?.every((x) => typeof x === 'number')).toBe(true);
  });
});

// A fake event target that lets us drive the capture handlers directly and feed
// adversarial events.
class FakeInput implements KeystrokeCaptureTarget {
  private handlers = new Map<string, ((event: KeystrokeProbeEvent) => void)[]>();

  addEventListener(type: 'keydown' | 'keyup', listener: (event: KeystrokeProbeEvent) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(listener);
    this.handlers.set(type, list);
  }

  removeEventListener(
    type: 'keydown' | 'keyup',
    listener: (event: KeystrokeProbeEvent) => void,
  ): void {
    const list = this.handlers.get(type);
    if (list) {
      this.handlers.set(
        type,
        list.filter((h) => h !== listener),
      );
    }
  }

  dispatch(type: 'keydown' | 'keyup', event: KeystrokeProbeEvent): void {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }

  listenerCount(): number {
    let total = 0;
    for (const list of this.handlers.values()) {
      total += list.length;
    }
    return total;
  }
}

describe('attachKeystrokeCapture — DOM wiring', () => {
  it('feeds timestamps from a monotonic clock into the recorder', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    const clock = [100, 180, 200, 260];
    let i = 0;
    const detach = attachKeystrokeCapture(input, recorder, () => clock[i++] ?? 0);

    input.dispatch('keydown', { repeat: false });
    input.dispatch('keyup', { repeat: false });
    input.dispatch('keydown', { repeat: false });
    input.dispatch('keyup', { repeat: false });

    // holds 80/60 ; DD 200-100=100 ; UD 200-180=20
    expect(recorder.extract()).toEqual([80, 60, 100, 20]);
    detach();
    expect(input.listenerCount()).toBe(0);
  });

  it('ignores auto-repeat keydowns', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    let t = 0;
    attachKeystrokeCapture(input, recorder, () => (t += 10));

    input.dispatch('keydown', { repeat: false });
    input.dispatch('keydown', { repeat: true }); // auto-repeat: must be dropped
    input.dispatch('keyup', { repeat: false });
    input.dispatch('keydown', { repeat: false });
    input.dispatch('keyup', { repeat: false });

    expect(recorder.length).toBe(2); // not 3
  });

  it('PRIVACY: the handler never reads character identity (proven by a throwing getter)', () => {
    const input = new FakeInput();
    const recorder = new KeystrokeRecorder();
    attachKeystrokeCapture(input, recorder, () => 1);

    // An event whose key/code/keyCode getters THROW if accessed. The capture must
    // not touch them — if it did, dispatch would throw.
    const trap = {
      repeat: false,
      get key(): string {
        throw new Error('key identity was accessed — PRIVACY VIOLATION');
      },
      get code(): string {
        throw new Error('code identity was accessed — PRIVACY VIOLATION');
      },
      get keyCode(): number {
        throw new Error('keyCode identity was accessed — PRIVACY VIOLATION');
      },
    } as unknown as KeystrokeProbeEvent;

    expect(() => {
      input.dispatch('keydown', trap);
      input.dispatch('keyup', trap);
      input.dispatch('keydown', trap);
      input.dispatch('keyup', trap);
    }).not.toThrow();
    expect(recorder.length).toBe(2); // timing still captured, identity untouched
  });
});
````

## D.3 Enrollment progress & continuous-auth spike-lock

`VaultView` hosts the behavioral-enrollment progress banner and the continuous-auth
client (stream mouse windows; on a server-commanded risk spike, zeroize keys and
return to unlock). `App` is the shell that remembers *why* it returned to the
unlock screen so the calm "locked for your security" notice can render.

### `apps/desktop/src/features/vault/VaultView.tsx`

````tsx
import type {
  Credential,
  CredentialInput,
  CredentialSummary,
  EnrollmentStatus,
} from '@cerberus/shared-types';
import { useEffect, useState } from 'react';

import { BrandMark, EyeIcon, LockIcon, PencilIcon, PlusIcon, TrashIcon } from '../../components/icons';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { WaveBars } from '../../components/ui/wave';
import { cn } from '../../lib/cn';
import type { AuthenticatedSession, LockReason } from '../auth/AuthScreen';
import { getTotpStatus } from '../../lib/api';
import { attachMouseCapture } from '../../lib/mouse-capture';
import {
  addCredential,
  deleteCredential,
  errorMessage,
  getCredential,
  listCredentials,
  lock,
  updateCredential,
} from '../../lib/tauri';
import { openContinuousAuth } from '../../lib/ws';
import { TotpEnrollment } from './TotpEnrollment';

const EMPTY_INPUT: CredentialInput = {
  name: '',
  username: '',
  password: '',
  url: '',
  notes: '',
};

interface VaultViewProps {
  /** `reason` is presentation only: 'risk' ⇒ a continuous-auth spike (show the lock notice). */
  onLock: (reason?: LockReason | 'manual') => void;
  session: AuthenticatedSession;
}

// Behavioral enrollment progress (Milestone 6): a progress indicator while the
// typing profile is being built, and a confirmation once it is active. The status
// carries only counts — never a raw feature vector (PROJECT.md §5). Restyled to the
// design language (ADR-0015): a brass "learning your rhythm" banner with a wave +
// progress bar while enrolling; a calm confirmation chip once active.
function EnrollmentBanner({ enrollment }: { enrollment: EnrollmentStatus }) {
  if (enrollment.status === 'active') {
    return (
      <div
        role="status"
        className="flex items-center gap-2.5 rounded-xl border border-ok/30 bg-ok/[0.08] px-[14px] py-2.5 text-[13px] font-medium text-ok"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-ok" /> Typing profile active
      </div>
    );
  }
  const pct = Math.min(100, Math.round((enrollment.samplesCollected / enrollment.samplesRequired) * 100));
  return (
    <div
      role="status"
      className="flex items-center gap-[18px] rounded-lg border border-accent/25 bg-gradient-to-r from-accent/10 to-accent/[0.03] px-[18px] py-[15px]"
    >
      <div className="hidden h-10 w-[120px] flex-none sm:block">
        <WaveBars count={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-[#f1c281]">
          Building your typing profile — {enrollment.samplesCollected} of {enrollment.samplesRequired}
        </div>
        <div className="mt-0.5 text-[12.5px] text-muted">
          Cerberus is learning your typing rhythm to protect your vault.
        </div>
        <div className="mt-2.5 h-[5px] overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent-lo to-accent-hi transition-[width] duration-500"
            style={{ width: `${String(pct)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function letterTile(name: string): string {
  return (name.trim()[0] ?? '•').toUpperCase();
}

// Credential plaintext (the password) is only pulled into the webview on demand
// — when revealing or editing a single item — and is never persisted to browser
// storage (PROJECT.md §4.2). The list shows only id/name/username.
export function VaultView({ onLock, session }: VaultViewProps) {
  const [items, setItems] = useState<CredentialSummary[]>([]);
  const [form, setForm] = useState<CredentialInput>(EMPTY_INPUT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Credential | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = unknown/not-applicable; false = needs a nudge; true = already enrolled.
  const [totpConfirmed, setTotpConfirmed] = useState<boolean | null>(null);

  const refresh = (): void => {
    void listCredentials()
      .then(setItems)
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  useEffect(refresh, []);

  // Once the typing profile is active, check whether a second factor exists; if
  // not, surface the enrollment nudge (fail-closed step-up would otherwise deny a
  // no-TOTP user on a risky login — ADR-0012). Best-effort: never blocks the vault.
  const token = session.token;
  const baselineActive = session.enrollment?.status === 'active';
  useEffect(() => {
    if (token === null || !baselineActive) {
      return;
    }
    void getTotpStatus(token)
      .then((s) => {
        setTotpConfirmed(s.confirmed);
      })
      .catch(() => {
        setTotpConfirmed(null); // unknown → no nudge, never block
      });
  }, [token, baselineActive]);

  // Continuous authentication (ADR-0013): while unlocked, stream mouse-dynamics
  // windows to the server. On a server-commanded lock (risk spike) zeroize the keys
  // via the M3 lock path and return to the unlock screen — re-unlock re-runs the M9
  // login risk evaluation. Capture reads only pointer geometry/timing, never content.
  useEffect(() => {
    if (token === null) {
      return;
    }
    let locked = false;
    const client = openContinuousAuth(token, {
      onLocked: () => {
        if (locked) {
          return;
        }
        locked = true;
        void lock()
          .catch(() => undefined)
          .finally(() => {
            onLock('risk');
          });
      },
    });
    const detach = attachMouseCapture(window, (features) => {
      client.sendWindow(features);
    });
    return () => {
      detach();
      client.close();
    };
  }, [token, onLock]);

  const resetForm = (): void => {
    setForm(EMPTY_INPUT);
    setEditingId(null);
  };

  const save = (): void => {
    setError(null);
    const action =
      editingId === null
        ? addCredential(form).then(() => undefined)
        : updateCredential(editingId, form);
    void action
      .then(() => {
        resetForm();
        refresh();
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const startEdit = (id: string): void => {
    setError(null);
    void getCredential(id)
      .then((c) => {
        setEditingId(c.id);
        setForm({
          name: c.name,
          username: c.username,
          password: c.password,
          url: c.url,
          notes: c.notes,
        });
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const reveal = (id: string): void => {
    setError(null);
    void getCredential(id)
      .then(setRevealed)
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const remove = (id: string): void => {
    setError(null);
    void deleteCredential(id)
      .then(() => {
        if (editingId === id) {
          resetForm();
        }
        if (revealed?.id === id) {
          setRevealed(null);
        }
        refresh();
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const doLock = (): void => {
    void lock()
      .catch(() => undefined)
      .finally(() => {
        onLock('manual');
      });
  };

  const setField = (field: keyof CredentialInput, value: string): void => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const iconBtn =
    'flex h-9 w-9 items-center justify-center rounded-[9px] text-muted2 hover:text-fg hover:bg-white/[0.06] transition-colors';

  return (
    <div className="surface-card flex h-[min(800px,92vh)] w-[min(1240px,96vw)] flex-col overflow-hidden rounded-2xl border border-line shadow-card animate-fadeUp">
      {/* TOP BAR */}
      <header className="flex h-16 flex-none items-center gap-3 border-b border-line2 px-[22px]">
        <BrandMark size={26} />
        <span className="font-display text-xl font-semibold tracking-[-0.01em]">Vault</span>
        <div className="flex-1" />
        <span className="flex items-center gap-[6px] rounded-full border border-ok/25 bg-ok/[0.08] py-[5px] pl-[9px] pr-[11px]">
          <span className="h-[7px] w-[7px] animate-glow rounded-full bg-ok shadow-[0_0_8px_#5bbf92]" />
          <span className="text-[11.5px] font-medium text-ok">Unlocked</span>
        </span>
        <Button variant="icon" size="icon" onClick={doLock} title="Lock vault" aria-label="Lock vault">
          <LockIcon size={17} />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* BANNERS */}
        <div className="flex flex-col gap-3 px-[18px] pt-4 empty:hidden">
          {session.enrollment !== null && <EnrollmentBanner enrollment={session.enrollment} />}
          {token !== null && baselineActive && totpConfirmed === false && (
            <TotpEnrollment
              token={token}
              onConfirmed={() => {
                setTotpConfirmed(true);
              }}
            />
          )}
          {error !== null && <Banner tone="error" title={error} />}
        </div>

        {/* PANES */}
        <div className="flex min-h-0 flex-1">
          {/* ITEM LIST */}
          <div className="flex w-[336px] flex-none flex-col border-r border-line2">
            <div className="flex items-center justify-between px-[18px] pb-2 pt-4">
              <span className="text-[11px] font-semibold tracking-[0.06em] text-faint">
                CREDENTIALS ({items.length})
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={resetForm}
                title="Add credential"
                aria-label="Add credential"
              >
                <PlusIcon size={17} />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
              {items.length === 0 ? (
                <div className="px-5 py-16 text-center">
                  <div className="text-[13.5px] font-semibold text-muted">No credentials yet</div>
                  <div className="mt-1 text-[12.5px] text-faint">
                    Add your first login on the right — Cerberus keeps it encrypted.
                  </div>
                </div>
              ) : (
                items.map((item) => {
                  const active = revealed?.id === item.id || editingId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        'group mb-[3px] flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors',
                        active
                          ? 'border-accent/30 bg-accent/[0.06]'
                          : 'border-transparent hover:border-line hover:bg-white/[0.03]',
                      )}
                    >
                      <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[10px] bg-elevated font-display text-[13px] font-bold text-accent">
                        {letterTile(item.name)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          reveal(item.id);
                        }}
                        className="min-w-0 flex-1 text-left"
                        title="Reveal"
                        aria-label={`Reveal ${item.name}`}
                      >
                        <span className="block truncate text-[13.5px] font-semibold text-fg">{item.name}</span>
                        <span className="block truncate text-[12px] text-muted2">{item.username}</span>
                      </button>
                      <button
                        type="button"
                        className={iconBtn}
                        onClick={() => {
                          reveal(item.id);
                        }}
                        title="Reveal"
                        aria-label="Reveal"
                      >
                        <EyeIcon size={16} />
                      </button>
                      <button
                        type="button"
                        className={iconBtn}
                        onClick={() => {
                          startEdit(item.id);
                        }}
                        title="Edit"
                        aria-label="Edit"
                      >
                        <PencilIcon size={16} />
                      </button>
                      <button
                        type="button"
                        className={cn(iconBtn, 'hover:text-danger')}
                        onClick={() => {
                          remove(item.id);
                        }}
                        title="Delete"
                        aria-label="Delete"
                      >
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* DETAIL: reveal card (if any) + the add/edit form */}
          <div className="min-h-0 flex-1 overflow-y-auto p-[26px]">
            {revealed !== null && (
              <section className="surface-elevated mb-6 max-w-[560px] rounded-xl border border-line p-6">
                <div className="flex items-start gap-3.5">
                  <span className="flex h-[50px] w-[50px] flex-none items-center justify-center rounded-[13px] bg-elevated font-display text-sm font-bold text-accent">
                    {letterTile(revealed.name)}
                  </span>
                  <h2 className="flex-1 pt-1 font-display text-[21px] font-semibold tracking-[-0.01em]">
                    {revealed.name}
                  </h2>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRevealed(null);
                    }}
                  >
                    Hide
                  </Button>
                </div>
                <dl className="mt-5 flex flex-col gap-5">
                  <div>
                    <dt className="text-[11.5px] text-muted2">Username</dt>
                    <dd className="mt-1 text-sm font-medium text-fg">{revealed.username || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[11.5px] text-muted2">Password</dt>
                    <dd className="mt-1 font-mono text-sm text-fg">
                      <code>{revealed.password}</code>
                    </dd>
                  </div>
                  {revealed.url.length > 0 && (
                    <div>
                      <dt className="text-[11.5px] text-muted2">Website</dt>
                      <dd className="mt-1 text-sm text-fg">{revealed.url}</dd>
                    </div>
                  )}
                  {revealed.notes.length > 0 && (
                    <div>
                      <dt className="text-[11.5px] text-muted2">Notes</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted">
                        {revealed.notes}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
            )}

            <section className="surface-elevated max-w-[560px] rounded-xl border border-line p-6">
              <h2 className="font-display text-lg font-semibold tracking-[-0.01em]">
                {editingId === null ? 'Add credential' : 'Edit credential'}
              </h2>
              <form
                className="mt-5 flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  save();
                }}
              >
                <Field label="Name">
                  <Input
                    aria-label="Name"
                    placeholder="e.g. GitHub"
                    value={form.name}
                    onChange={(e) => {
                      setField('name', e.target.value);
                    }}
                  />
                </Field>
                <Field label="Username">
                  <Input
                    aria-label="Username"
                    placeholder="you@example.com"
                    value={form.username}
                    onChange={(e) => {
                      setField('username', e.target.value);
                    }}
                  />
                </Field>
                <Field label="Password">
                  <Input
                    aria-label="Password"
                    placeholder="••••••••••••"
                    type="password"
                    className="font-mono"
                    value={form.password}
                    onChange={(e) => {
                      setField('password', e.target.value);
                    }}
                  />
                </Field>
                <Field label="URL">
                  <Input
                    aria-label="URL"
                    placeholder="https://…"
                    value={form.url}
                    onChange={(e) => {
                      setField('url', e.target.value);
                    }}
                  />
                </Field>
                <label className="block">
                  <span className="block text-xs font-medium text-muted">Notes</span>
                  <textarea
                    aria-label="Notes"
                    placeholder="Anything else to remember…"
                    rows={3}
                    className="mt-[7px] w-full resize-none rounded-[11px] border border-white/10 bg-field px-[14px] py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
                    value={form.notes}
                    onChange={(e) => {
                      setField('notes', e.target.value);
                    }}
                  />
                </label>
                <div className="flex items-center gap-2 pt-1">
                  <Button type="submit" size="sm" disabled={form.name.length === 0}>
                    {editingId === null ? 'Add credential' : 'Save changes'}
                  </Button>
                  {editingId !== null && (
                    <Button type="button" variant="secondary" size="sm" onClick={resetForm}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
````

### `apps/desktop/src/App.tsx`

````tsx
import { useState } from 'react';

import { AuthScreen, type AuthenticatedSession, type LockReason } from './features/auth/AuthScreen';
import { VaultView } from './features/vault/VaultView';

// Top-level shell: a dark "vault" canvas (ADR-0015) hosting the auth screen
// (register/login) until authenticated, then the vault view. No secret state lives
// here — keys stay in Rust (PROJECT.md §1.2). The session carried here is the
// non-secret token + the behavioral enrollment progress (Milestone 6).
//
// `lockReason` is PRESENTATION ONLY: it remembers WHY we returned to the unlock
// screen so a continuous-auth lock can show a calm "locked for your security"
// notice. It changes no flow — the lock path (zeroize keys → re-unlock) is
// unchanged; only which message is shown differs.
export function App() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [lockReason, setLockReason] = useState<LockReason>(null);

  return (
    <div className="app-canvas">
      {session === null ? (
        <AuthScreen
          lockNotice={lockReason}
          onAuthenticated={(s) => {
            setLockReason(null);
            setSession(s);
          }}
        />
      ) : (
        <VaultView
          session={session}
          onLock={(reason) => {
            setLockReason(reason === 'risk' ? 'risk' : null);
            setSession(null);
          }}
        />
      )}
    </div>
  );
}
````

## D.4 TOTP step-up component

### `apps/desktop/src/features/vault/TotpEnrollment.tsx`

````tsx
// TOTP enrollment nudge (Milestone 10, Part A; restyled M12 / ADR-0015). Reachable
// from the vault once the behavioral baseline is active: fail-closed step-up
// (ADR-0012) DENIES a user with no confirmed second factor when risk escalates, so
// an active-baseline user is prompted to set up TOTP. Uses the existing
// setup/confirm endpoints; the secret/URI are shown once for the authenticator app.
// PRESENTATION ONLY — handlers, endpoints, and copy semantics are unchanged.
import type { TotpSetupResponse } from '@cerberus/shared-types';
import { useState } from 'react';

import { ShieldCheckIcon } from '../../components/icons';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { confirmTotp, setupTotp } from '../../lib/api';
import { errorMessage } from '../../lib/tauri';

interface TotpEnrollmentProps {
  /** Authenticated session token (the nudge only renders for an active session). */
  token: string;
  /** Called once the second factor is confirmed, so the parent can hide the nudge. */
  onConfirmed: () => void;
}

type Phase = 'prompt' | 'setup';

export function TotpEnrollment({ token, onConfirmed }: TotpEnrollmentProps) {
  const [phase, setPhase] = useState<Phase>('prompt');
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = (): void => {
    setError(null);
    setBusy(true);
    void setupTotp(token)
      .then((res) => {
        setSetup(res);
        setPhase('setup');
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const confirm = (): void => {
    setError(null);
    setBusy(true);
    void confirmTotp(token, { code })
      .then((res) => {
        if (res.confirmed) {
          setCode('');
          onConfirmed();
        } else {
          setError('That code did not match. Try again.');
        }
      })
      .catch(() => {
        // The confirm endpoint returns 400 for a bad code (an ApiError here).
        setError('That code did not match. Try again.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (phase === 'prompt') {
    return (
      <section
        role="region"
        aria-label="Two-step verification"
        className="flex items-center gap-3.5 rounded-[13px] border border-info/20 bg-info/[0.07] px-4 py-[13px]"
      >
        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-info/[0.14] text-info">
          <ShieldCheckIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-fg">Add a second factor</div>
          <div className="mt-px text-[12.5px] text-muted">
            Keep step-up verification working if a login ever needs confirming.
          </div>
        </div>
        <Button size="chip" onClick={begin} disabled={busy} className="flex-none">
          {busy ? 'Starting…' : 'Set up'}
        </Button>
        {error !== null && <Banner className="basis-full" tone="error" title={error} />}
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label="Two-step verification"
      className="surface-elevated rounded-[14px] border border-line p-5"
    >
      <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em]">Add a second factor</h2>
      <p className="mt-1.5 text-[12.5px] leading-[1.5] text-muted">
        Add the setup key to your authenticator app, then enter the 6-digit code to confirm.
      </p>

      {setup !== null && (
        <div className="mt-4 rounded-xl border border-line bg-field px-4 py-3">
          <div className="text-[11px] tracking-[0.04em] text-muted2">SETUP KEY</div>
          <code className="mt-1.5 block break-all font-mono text-[13px] leading-[1.5] text-fg">
            {setup.secret}
          </code>
        </div>
      )}

      <form
        className="mt-4 flex items-center gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <Input
          aria-label="Confirmation code"
          placeholder="123456"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          className="h-11 max-w-[180px] font-mono tracking-[0.3em]"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
          }}
          disabled={busy}
        />
        <Button type="submit" size="sm" disabled={busy || code.length < 6}>
          {busy ? 'Confirming…' : 'Confirm'}
        </Button>
      </form>
      {error !== null && <Banner className="mt-3" tone="error" title={error} />}
    </section>
  );
}
````

