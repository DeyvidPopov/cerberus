import { useState } from 'react';

import { loginAccount, registerAccount } from '../../lib/auth';
import { errorMessage } from '../../lib/tauri';

interface AuthScreenProps {
  onAuthenticated: () => void;
}

type Mode = 'login' | 'register';

// Entry screen replacing M3's auto-init-on-first-unlock. Registration requires a
// confirmation field (prevents the M3 typo-lockout). The master password lives in
// component state only until it is handed to the Rust derivation, then it is
// cleared (PROJECT.md §4.2); it is never written to browser storage and never
// sent to the server.
export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clearSecrets = (): void => {
    setPassword('');
    setConfirm('');
  };

  const submit = (): void => {
    setError(null);
    if (mode === 'register' && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    const action =
      mode === 'register'
        ? registerAccount(username, password)
        : loginAccount(username, password).then(() => undefined);
    void action
      .then(() => {
        clearSecrets();
        onAuthenticated();
      })
      .catch((e: unknown) => {
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
