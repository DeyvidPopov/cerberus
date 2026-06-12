import type { EnrollmentStatus, GrantedLoginResponse } from '@cerberus/shared-types';
import { useState } from 'react';

import { getEnrollmentStatus } from '../../lib/api';
import { completeStepUp, loginAccount, registerAccount } from '../../lib/auth';
import { useKeystrokeCapture } from '../../lib/keystroke-capture';
import { errorMessage } from '../../lib/tauri';

/** What a completed auth hands up: the session token and (on login) enrollment progress. */
export interface AuthenticatedSession {
  token: string | null;
  enrollment: EnrollmentStatus | null;
}

interface AuthScreenProps {
  onAuthenticated: (session: AuthenticatedSession) => void;
}

type Mode = 'login' | 'register';

// Entry screen. The master password lives in component state only until handed to
// the Rust derivation, then cleared (PROJECT.md §4.2). The password input's
// KEYSTROKE TIMING (positions only, never characters — see lib/keystroke) is
// captured during login and sent WITH the login request as a position-indexed
// feature vector; the server runs the adaptive policy (ADR-0012) and either grants
// a session or requires a TOTP step-up. The password value still flows only to Rust.
export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  const run = (action: () => Promise<void>): void => {
    setError(null);
    setBusy(true);
    void action()
      .catch((e: unknown) => {
        capture.reset();
        clearSecrets();
        setError(errorMessage(e));
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
    run(mode === 'register' ? doRegister : doLogin);
  };

  const toggleMode = (): void => {
    setMode((current) => (current === 'login' ? 'register' : 'login'));
    setError(null);
    setChallengeToken(null);
    capture.reset();
    clearSecrets();
  };

  // Step-up prompt: a second factor is required before the session is issued.
  if (challengeToken !== null) {
    return (
      <main className="screen">
        <h1>Cerberus</h1>
        <h2>Verify it’s you</h2>
        <p>Enter the 6-digit code from your authenticator app.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(doStepUp);
          }}
        >
          <input
            aria-label="Authenticator code"
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={totpCode}
            onChange={(e) => {
              setTotpCode(e.target.value);
            }}
            disabled={busy}
          />
          <button type="submit" disabled={busy || totpCode.length < 6}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </form>
        <button
          type="button"
          onClick={() => {
            setChallengeToken(null);
            setError(null);
          }}
          disabled={busy}
        >
          Cancel
        </button>
        {error !== null && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>Cerberus</h1>
      <h2>{mode === 'register' ? 'Create your vault' : 'Unlock your vault'}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          aria-label="Username"
          placeholder="Username"
          autoComplete="username"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
          disabled={busy}
        />
        <input
          ref={capture.inputRef}
          type="password"
          aria-label="Master password"
          placeholder="Master password"
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          disabled={busy}
        />
        {mode === 'register' && (
          <input
            type="password"
            aria-label="Confirm master password"
            placeholder="Confirm master password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
            }}
            disabled={busy}
          />
        )}
        <button type="submit" disabled={busy || username.length === 0 || password.length === 0}>
          {busy ? 'Working…' : mode === 'register' ? 'Register' : 'Log in'}
        </button>
      </form>
      <button type="button" onClick={toggleMode} disabled={busy}>
        {mode === 'register' ? 'Have an account? Log in' : 'New here? Create a vault'}
      </button>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}
