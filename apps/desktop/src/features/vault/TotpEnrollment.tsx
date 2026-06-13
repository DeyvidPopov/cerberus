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
