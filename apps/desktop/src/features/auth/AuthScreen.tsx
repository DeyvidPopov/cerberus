import { FEATURE_SCHEMA_VERSION, type EnrollmentStatus } from '@cerberus/shared-types';
import { useState } from 'react';

import { submitEnrollmentSample } from '../../lib/api';
import { loginAccount, registerAccount } from '../../lib/auth';
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

// Entry screen replacing M3's auto-init-on-first-unlock. Registration requires a
// confirmation field (prevents the M3 typo-lockout). The master password lives in
// component state only until it is handed to the Rust derivation, then it is
// cleared (PROJECT.md §4.2); it is never written to browser storage and never
// sent to the server.
//
// Milestone 6: the password input's KEYSTROKE TIMING (positions only, never
// characters — see lib/keystroke) is captured during login and, after a
// SUCCESSFUL login, submitted to the enrollment endpoint as a position-indexed
// feature vector. The password value itself still flows only to Rust.
export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const capture = useKeystrokeCapture();

  const clearSecrets = (): void => {
    setPassword('');
    setConfirm('');
  };

  const doRegister = async (): Promise<void> => {
    await registerAccount(username, password);
    capture.reset(); // discard any captured timing; enrollment happens on login
    clearSecrets();
    onAuthenticated({ token: null, enrollment: null });
  };

  const doLogin = async (): Promise<void> => {
    const session = await loginAccount(username, password);
    // The capture is meaningful only after a successful login. Submitting the
    // sample is best-effort — enrollment must NEVER block authentication.
    const features = capture.takeSample();
    let enrollment: EnrollmentStatus | null = null;
    if (features !== null) {
      try {
        enrollment = await submitEnrollmentSample(session.sessionToken, {
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          features,
        });
      } catch {
        enrollment = null;
      }
    }
    clearSecrets();
    onAuthenticated({ token: session.sessionToken, enrollment });
  };

  const submit = (): void => {
    setError(null);
    if (mode === 'register' && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    void (mode === 'register' ? doRegister() : doLogin())
      .catch((e: unknown) => {
        capture.reset(); // a fresh capture starts on the next attempt
        clearSecrets();
        setError(errorMessage(e));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const toggleMode = (): void => {
    setMode((current) => (current === 'login' ? 'register' : 'login'));
    setError(null);
    capture.reset();
    clearSecrets();
  };

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
