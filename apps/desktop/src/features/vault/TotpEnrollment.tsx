// TOTP enrollment nudge (Milestone 10, Part A). Reachable from the vault once the
// behavioral baseline is active: fail-closed step-up (ADR-0012) DENIES a user with
// no confirmed second factor when risk escalates, so an active-baseline user must
// be prompted to set up TOTP. Uses the existing setup/confirm endpoints; the
// secret is shown once for the user to add to an authenticator app.
import type { TotpSetupResponse } from '@cerberus/shared-types';
import { useState } from 'react';

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
      <section className="totp-nudge" role="region" aria-label="Two-step verification">
        <h2>Add two-step verification</h2>
        <p>
          Your typing profile is active. Set up an authenticator app so you can still get in if a
          login looks risky.
        </p>
        <button type="button" onClick={begin} disabled={busy}>
          {busy ? 'Starting…' : 'Set up'}
        </button>
        {error !== null && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="totp-nudge" role="region" aria-label="Two-step verification">
      <h2>Scan or enter this secret</h2>
      <p>Add this to your authenticator app, then enter the 6-digit code to confirm.</p>
      {setup !== null && (
        <dl>
          <dt>Secret</dt>
          <dd>
            <code>{setup.secret}</code>
          </dd>
        </dl>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <input
          aria-label="Confirmation code"
          placeholder="123456"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
          }}
          disabled={busy}
        />
        <button type="submit" disabled={busy || code.length < 6}>
          {busy ? 'Confirming…' : 'Confirm'}
        </button>
      </form>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
