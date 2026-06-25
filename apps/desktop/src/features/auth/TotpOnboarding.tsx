// Mandatory second-factor onboarding (shot 1). A full-screen step shown after login
// when the account has no confirmed TOTP yet — every user sets up 2FA before reaching
// the vault (no skip). Reuses the existing setup/confirm endpoints (the secret + QR are
// shown once for the authenticator app) and the shared AuthFrame two-panel shell.
// PRESENTATION + flow only — no crypto here; the secret is generated + verified server
// side, and the otpauth QR is rendered LOCALLY (never sent to any external service).
import { useEffect, useRef, useState } from 'react';
import { toDataURL } from 'qrcode';

import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { CheckIcon, CopyIcon, ShieldCheckIcon } from '../../components/icons';
import { confirmTotp, setupTotp } from '../../lib/api';
import { errorMessage } from '../../lib/tauri';
import { AuthFrame } from './AuthFrame';
import { StepHeader, type StepInfo } from './StepHeader';

interface TotpOnboardingProps {
  /** Authenticated session token (this screen only renders for an active session). */
  token: string;
  /** Called once the second factor is confirmed → the parent advances. */
  onConfirmed: () => void;
  /** Leave without finishing (returns to the unlock screen — NOT a skip; the vault stays gated). */
  onSignOut: () => void;
  /** Position in the onboarding wizard (omit when shown standalone). */
  step?: StepInfo;
}

const EMPTY: string[] = ['', '', '', '', '', ''];

/** Format a base32 secret into space-separated groups of four (e.g. JBSW Y3DP …). */
function formatKey(secret: string): string {
  return (secret.match(/.{1,4}/gu) ?? [secret]).join(' ');
}

export function TotpOnboarding({ token, onConfirmed, onSignOut, step }: TotpOnboardingProps) {
  const [secret, setSecret] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Begin setup on mount: get a fresh secret + provisioning URI, render the QR locally.
  useEffect(() => {
    let cancelled = false;
    setSetupError(null);
    void setupTotp(token)
      .then(async (res) => {
        if (cancelled) {
          return;
        }
        setSecret(res.secret);
        const dataUrl = await toDataURL(res.provisioningUri, {
          margin: 1,
          width: 150,
          color: { dark: '#0B0C0F', light: '#FFFFFF' },
        });
        if (!cancelled) {
          setQr(dataUrl);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setSetupError(errorMessage(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const code = digits.join('');

  // `submitCode` lets the auto-submit pass the just-completed code directly (avoiding a
  // stale `digits` closure); the button submits with the current state code.
  const confirm = (submitCode?: string): void => {
    const value = submitCode ?? code;
    if (value.length < 6 || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    void confirmTotp(token, { code: value })
      .then((res) => {
        if (res.confirmed) {
          onConfirmed();
        } else {
          setError('That code did not match. Try again.');
          setDigits(EMPTY);
        }
      })
      .catch(() => {
        // The confirm endpoint returns 400 for a bad code (an ApiError here).
        setError('That code did not match. Try again.');
        setDigits(EMPTY);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const copyKey = (): void => {
    if (secret === null) {
      return;
    }
    void navigator.clipboard
      ?.writeText(secret)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1600);
      })
      .catch(() => undefined);
  };

  return (
    <AuthFrame>
      <StepHeader
        step={step ?? { n: 1, total: 1 }}
        title="Add a second factor"
        subtitle="A second factor protects your vault if your master password is ever guessed, phished, or stolen."
      />

      <div className="mt-4 flex items-start gap-3 rounded-xl border border-info/20 bg-info/[0.06] p-3.5">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-info/[0.14] text-info">
          <ShieldCheckIcon size={18} />
        </span>
        <p className="text-[12.5px] leading-[1.5] text-muted">
          Scan the QR with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code.
          We can&rsquo;t reset your vault — this is your safety net.
        </p>
      </div>

      {setupError !== null && <Banner className="mt-4" tone="error" title={setupError} />}

      <div className="mt-4 flex items-start gap-4">
        <div className="flex h-[132px] w-[132px] flex-none items-center justify-center overflow-hidden rounded-xl border border-line2 bg-white">
          {qr !== null ? (
            <img src={qr} alt="Authenticator setup QR code" width={132} height={132} />
          ) : (
            <span className="text-[11px] text-muted2">Generating…</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] tracking-[0.06em] text-muted2">SETUP KEY</div>
          <code className="mt-1.5 block break-all font-mono text-[13px] leading-[1.6] text-fg">
            {secret !== null ? formatKey(secret) : '··········'}
          </code>
          <button
            type="button"
            onClick={copyKey}
            disabled={secret === null}
            className="mt-2 flex items-center gap-1.5 text-[12.5px] font-medium text-accent-hi hover:text-accent disabled:opacity-50"
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            {copied ? 'Copied' : 'Copy key'}
          </button>
        </div>
      </div>

      <form
        className="mt-5"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <OtpBoxes digits={digits} setDigits={setDigits} disabled={busy} onComplete={confirm} />
        {error !== null && <Banner className="mt-4" tone="error" title={error} />}
        <Button type="submit" className="mt-5 w-full" disabled={busy || code.length < 6 || secret === null}>
          {busy ? 'Confirming…' : 'Confirm & enable'}
        </Button>
      </form>

      <button
        type="button"
        onClick={onSignOut}
        disabled={busy}
        className="mt-4 block w-full text-center text-[13px] text-muted2 hover:text-fg disabled:opacity-50"
      >
        Sign out
      </button>
    </AuthFrame>
  );
}

/** Six single-digit boxes with auto-advance, backspace-back, and paste-to-fill. */
function OtpBoxes({
  digits,
  setDigits,
  disabled,
  onComplete,
}: {
  digits: string[];
  setDigits: (next: string[]) => void;
  disabled: boolean;
  onComplete: (code: string) => void;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const focusAt = (i: number): void => {
    refs.current[Math.max(0, Math.min(5, i))]?.focus();
  };

  const setAt = (i: number, raw: string): void => {
    const ch = raw.replace(/[^0-9]/gu, '').slice(-1);
    const next = [...digits];
    next[i] = ch;
    setDigits(next);
    if (ch !== '' && i < 5) {
      focusAt(i + 1);
    }
    if (next.join('').length === 6) {
      onComplete(next.join(''));
    }
  };

  const onKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace' && digits[i] === '' && i > 0) {
      focusAt(i - 1);
    } else if (e.key === 'ArrowLeft') {
      focusAt(i - 1);
    } else if (e.key === 'ArrowRight') {
      focusAt(i + 1);
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData('text').replace(/[^0-9]/gu, '').slice(0, 6);
    if (text.length === 0) {
      return;
    }
    e.preventDefault();
    const next = [...EMPTY];
    for (let i = 0; i < text.length; i += 1) {
      next[i] = text[i] ?? '';
    }
    setDigits(next);
    focusAt(text.length);
    if (text.length === 6) {
      onComplete(next.join(''));
    }
  };

  return (
    <div className="flex justify-between">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          aria-label={`Digit ${String(i + 1)}`}
          value={d}
          disabled={disabled}
          onChange={(e) => {
            setAt(i, e.target.value);
          }}
          onKeyDown={(e) => {
            onKeyDown(i, e);
          }}
          onPaste={onPaste}
          className="h-[52px] w-[48px] flex-none rounded-xl border border-line2 bg-field text-center font-mono text-xl text-fg outline-none transition-colors focus:border-accent/60 focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
        />
      ))}
    </div>
  );
}
