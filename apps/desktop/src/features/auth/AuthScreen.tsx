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
