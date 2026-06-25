// Onboarding step 2 — learn the user's typing RHYTHM (behavioral baseline, M6/ADR-0009).
//
// The user types their master password a few times; each entry's position-indexed timing
// (hold/flight durations — NEVER the characters) is sent to /enrollment/samples. After
// `samplesRequired` samples the server fits + activates the baseline. This is the explicit,
// explained version of what otherwise happens passively over several logins.
//
// Privacy: only timing crosses the wire (PROJECT.md §5). The password is typed locally to
// produce the rhythm; its characters never enter the behavioral path.
import type { EnrollmentStatus } from '@cerberus/shared-types';
import { FEATURE_SCHEMA_VERSION } from '@cerberus/shared-types';
import { useRef, useState } from 'react';

import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { CheckIcon, EyeIcon, EyeOffIcon } from '../../components/icons';
import { WaveBars } from '../../components/ui/wave';
import { ApiError, resetEnrollment, submitEnrollmentSample } from '../../lib/api';
import { useKeystrokeCapture } from '../../lib/keystroke-capture';
import { errorMessage } from '../../lib/tauri';
import { AuthFrame } from './AuthFrame';
import { StepHeader } from './StepHeader';

interface RhythmEnrollmentProps {
  token: string;
  initialStatus: EnrollmentStatus | null;
  step: { n: number; total: number };
  /** Advance the wizard (on success, or when the user skips for now). */
  onDone: () => void;
  onSignOut: () => void;
}

export function RhythmEnrollment({ token, initialStatus, step, onDone, onSignOut }: RhythmEnrollmentProps) {
  const [status, setStatus] = useState<EnrollmentStatus | null>(initialStatus);
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [justCaptured, setJustCaptured] = useState(false);
  const capture = useKeystrokeCapture();
  const inputEl = useRef<HTMLInputElement | null>(null);

  const startOver = (): void => {
    setError(null);
    setValue('');
    setResetting(true);
    void resetEnrollment(token)
      .then((fresh) => {
        setStatus(fresh);
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      })
      .finally(() => {
        setResetting(false);
        inputEl.current?.focus();
      });
  };

  const collected = status?.samplesCollected ?? 0;
  const required = status?.samplesRequired ?? 10;
  const active = status?.status === 'active';
  const pct = Math.min(100, Math.round((collected / Math.max(1, required)) * 100));

  const submit = (): void => {
    if (busy || active) {
      return;
    }
    const sample = capture.takeSample();
    setValue('');
    if (sample === null) {
      // Tainted (a paste / correction) or too few keys → no clean rhythm captured.
      setError('We couldn’t read a clean rhythm. TYPE your whole master password — don’t paste, and don’t backspace mid-word.');
      inputEl.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    void submitEnrollmentSample(token, { featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: sample })
      .then((next) => {
        setStatus(next);
        setJustCaptured(true);
        setTimeout(() => {
          setJustCaptured(false);
        }, 900);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 400) {
          setError('That didn’t match your earlier attempts. If you pasted or mistyped before, press “Start over” below, then type it cleanly.');
        } else if (e instanceof ApiError && e.status === 409) {
          setError('Please update the app to finish enrolment.');
        } else {
          setError(errorMessage(e));
        }
      })
      .finally(() => {
        setBusy(false);
        inputEl.current?.focus();
      });
  };

  return (
    <AuthFrame>
      <StepHeader
        step={step}
        title="Build your typing rhythm"
        subtitle="Cerberus learns the rhythm of HOW you type your master password — the tiny timing between keys, as unique as a signature."
      />

      <div className="mt-4 flex items-start gap-3 rounded-xl border border-info/20 bg-info/[0.06] p-3.5">
        <div className="hidden h-9 w-[88px] flex-none sm:block">
          <WaveBars count={11} />
        </div>
        <p className="text-[12.5px] leading-[1.5] text-muted">
          With your rhythm, the vault can tell it&rsquo;s really you — even if someone else learns your password. Only
          the <span className="font-medium text-fg">timing</span> is captured; never the characters.
        </p>
      </div>

      {active ? (
        <div className="mt-6 text-center">
          <div className="mx-auto flex h-[54px] w-[54px] items-center justify-center rounded-[15px] border border-ok/30 bg-ok/[0.12] text-ok">
            <CheckIcon size={26} />
          </div>
          <h2 className="mt-4 font-display text-xl font-semibold tracking-[-0.01em]">Your typing profile is ready</h2>
          <p className="mx-auto mt-2 max-w-[320px] text-[13px] leading-[1.5] text-muted">
            Cerberus will quietly check this rhythm on every sign-in from now on.
          </p>
          <Button className="mt-5 w-full" onClick={onDone}>
            Continue
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-muted">Captured {collected} of {required}</span>
              <span className="font-mono text-muted2">{pct}%</span>
            </div>
            <div className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-accent-lo to-accent-hi transition-[width] duration-300"
                style={{ width: `${String(pct)}%` }}
              />
            </div>
          </div>

          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="relative">
              <input
                ref={(el) => {
                  inputEl.current = el;
                  capture.inputRef(el);
                }}
                type={show ? 'text' : 'password'}
                aria-label="Master password"
                placeholder="Type your master password and press Enter"
                autoComplete="off"
                className="h-11 w-full rounded-[11px] border border-line2 bg-field pl-[14px] pr-11 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                }}
                onPaste={(e) => {
                  // Pasting can't capture a typing rhythm — block it and say so.
                  e.preventDefault();
                  setValue('');
                  setError('Please TYPE your master password — pasting can’t capture your typing rhythm.');
                }}
                disabled={busy}
              />
              <button
                type="button"
                aria-label={show ? 'Hide password' : 'Show password'}
                onClick={() => {
                  setShow((s) => !s);
                }}
                className="absolute right-1.5 top-1.5 flex h-[34px] w-[34px] items-center justify-center rounded-lg text-muted2 hover:text-fg"
              >
                {show ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
              </button>
            </div>
            {justCaptured && !error && (
              <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ok">
                <CheckIcon size={13} /> Captured — type it again
              </div>
            )}
            {error !== null && <Banner className="mt-3" tone="error" title={error} />}
            <Button type="submit" className="mt-4 w-full" disabled={busy || value.length === 0}>
              {busy ? 'Capturing…' : `Capture rhythm (${collected}/${required})`}
            </Button>
          </form>

          <div className="mt-4 flex items-center justify-center gap-4 text-[13px]">
            {collected > 0 && (
              <button type="button" onClick={startOver} disabled={resetting} className="text-muted2 hover:text-fg disabled:opacity-50">
                {resetting ? 'Starting over…' : 'Start over'}
              </button>
            )}
            <button type="button" onClick={onDone} className="text-muted2 hover:text-fg">
              Skip for now
            </button>
          </div>
          <p className="mt-1.5 text-center text-[11.5px] text-faint">
            Skipping is fine — Cerberus keeps learning your rhythm as you sign in.
          </p>
        </>
      )}

      <button
        type="button"
        onClick={onSignOut}
        className="mt-2 block w-full text-center text-[12.5px] text-faint hover:text-muted"
      >
        Sign out
      </button>
    </AuthFrame>
  );
}
