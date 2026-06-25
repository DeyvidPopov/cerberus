import type { EnrollmentStatus, GrantedLoginResponse, KdfParams, RiskExplanation } from '@cerberus/shared-types';
import { DeniedLoginResponseSchema } from '@cerberus/shared-types';
import { useMemo, useRef, useState } from 'react';

import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { AlertIcon, CheckIcon, EyeIcon, EyeOffIcon, ShieldCheckIcon } from '../../components/icons';
import { ApiError, getEnrollmentStatus } from '../../lib/api';
import { cn } from '../../lib/cn';
import { evaluatePassword, type PasswordStrength } from '../../lib/password-strength';
import { loginErrorMessage, registerErrorMessage, stepUpErrorMessage } from '../../lib/auth-errors';
import { completeStepUp, loginAccount, registerAccount, unlockAndPull } from '../../lib/auth';
import { useKeystrokeCapture } from '../../lib/keystroke-capture';
import { AuthFrame } from './AuthFrame';

/**
 * What a completed auth hands up: the session token, (on login) enrollment
 * progress, and whether the LOCAL vault was unlocked — i.e. whether the encryption
 * key is now held in memory. `vaultUnlocked` is the single source of truth the
 * vault screen reads for its lock state. Registration authenticates but does NOT
 * derive the vault key, so it hands up `vaultUnlocked: false`.
 */
export interface AuthenticatedSession {
  token: string | null;
  enrollment: EnrollmentStatus | null;
  vaultUnlocked: boolean;
}

/** Why the unlock screen was shown again. 'risk' ⇒ a continuous-auth spike locked the vault. */
export type LockReason = 'risk' | null;

interface AuthScreenProps {
  onAuthenticated: (session: AuthenticatedSession) => void;
  /** PRESENTATION ONLY: show a calm "locked for your security" notice on re-unlock. */
  lockNotice?: LockReason;
}

type Mode = 'login' | 'register';

/**
 * DEMO/THESIS ONLY: pull the deny breakdown a dev/demo server attaches to a 403. A
 * production server never sends it (so this returns null) — the user-facing copy stays
 * the generic "Access denied" (PROJECT.md §1, ADR-0012/0015). This only RENDERS data the
 * server chose to expose outside production; it cannot reveal anything on its own.
 */
function extractDenyRisk(e: unknown): RiskExplanation | null {
  if (!(e instanceof ApiError) || e.status !== 403) {
    return null;
  }
  const parsed = DeniedLoginResponseSchema.safeParse(e.detail);
  return parsed.success ? (parsed.data.risk ?? null) : null;
}

/** The demonstration-only "why was this denied?" panel (clearly labelled non-production). */
function DenyExplanation({ risk }: { risk: RiskExplanation }) {
  const sorted = [...risk.signals].sort((a, b) => b.contribution - a.contribution);
  const max = Math.max(0.001, ...sorted.map((s) => s.contribution));
  return (
    <div className="mt-4 rounded-xl border border-danger/30 bg-danger/[0.06] p-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-danger">
        <AlertIcon size={14} /> Demonstration — why this was denied
      </div>
      <p className="mt-1 text-[11.5px] leading-[1.45] text-muted2">
        Research / thesis view only. A production build never reveals this — the user just sees “Access denied.”
      </p>
      <div className="mt-3 flex items-center justify-between text-[12.5px]">
        <span className="text-muted">Composite risk</span>
        <span className="font-mono text-fg">
          {risk.composite.toFixed(2)} <span className="text-muted2">/ deny ≥ {risk.threshold.toFixed(2)}</span>
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-2.5">
        {sorted.map((s) => (
          <div key={s.label}>
            <div className="flex items-center justify-between text-[12px]">
              <span className="font-medium text-fg">{s.label}</span>
              <span className="font-mono text-muted">{s.contribution.toFixed(2)}</span>
            </div>
            <div className="mt-1 h-[5px] overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className="h-full rounded-full bg-danger/70"
                style={{ width: `${String(Math.round((s.contribution / max) * 100))}%` }}
              />
            </div>
            <div className="mt-1 text-[11.5px] leading-[1.4] text-muted2">{s.reason}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** What `finishGranted` needs to open + pull-sync the local vault after a grant. */
interface UnlockContext {
  masterPassword: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  /** The account's username — scopes the LOCAL vault file per account (so accounts on
   *  one machine don't collide on a single shared vault). */
  username: string;
}

/** A single requirement row in the master-password checklist. */
function Requirement({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex items-center gap-2 text-[12px]">
      <span className={cn('flex h-3.5 w-3.5 flex-none items-center justify-center', ok ? 'text-ok' : 'text-muted2')}>
        {ok ? <CheckIcon size={12} /> : <span className="h-[3px] w-[3px] rounded-full bg-current" />}
      </span>
      <span className={ok ? 'text-muted' : 'text-muted2'}>{text}</span>
    </li>
  );
}

/** Master-password strength meter + requirements, shown only when CREATING a vault. The
 *  master password never leaves the device, so this is assessed purely client-side. */
function PasswordGuidance({ strength }: { strength: PasswordStrength }) {
  const barColor = strength.score <= 1 ? 'bg-danger' : strength.score === 2 ? 'bg-accent' : 'bg-ok';
  const labelColor = strength.score <= 1 ? 'text-danger' : strength.score === 2 ? 'text-accent-hi' : 'text-ok';
  return (
    <div className="mt-2.5" aria-live="polite">
      <div className="flex items-center gap-2.5">
        <div className="flex flex-1 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={cn('h-[3px] flex-1 rounded-full transition-colors', i < strength.score ? barColor : 'bg-white/[0.08]')}
            />
          ))}
        </div>
        <span className={cn('w-[52px] text-right text-[11px] font-semibold', labelColor)}>{strength.label}</span>
      </div>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        <Requirement ok={strength.checks.length} text="At least 12 characters" />
        <Requirement ok={strength.checks.variety} text="Mix letters, numbers or symbols — or make it long" />
        <Requirement ok={strength.checks.notCommon} text="Not a common or guessable password" />
      </ul>
      <p className="mt-2 text-[11.5px] leading-[1.45] text-faint">
        This is the one password that unlocks everything — we can&rsquo;t reset it. A long passphrase is easiest to
        remember and hardest to guess.
      </p>
    </div>
  );
}

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
  // DEMO-ONLY: the breakdown a dev/demo server attaches to a high-risk deny. In a
  // production build the server omits it (stays null), so the deny copy is generic.
  const [denyRisk, setDenyRisk] = useState<RiskExplanation | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  // True right after registering — shows a "now sign in" banner on the login step.
  const [registered, setRegistered] = useState(false);
  // When a login bands to step_up, hold the challenge until the TOTP code is entered.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const capture = useKeystrokeCapture();
  // Client-side master-password grading (never sent anywhere). Declared up here with the
  // other hooks — BEFORE the step-up early return — so the hook order stays stable.
  const strength = useMemo(() => evaluatePassword(password), [password]);
  // The context needed to open AND pull-sync the LOCAL vault once a step-up passes:
  // the master password + the prelogin KDF salt/params. Held in a ref (not rendered,
  // survives a wrong-code retry) and wiped the instant the vault unlocks or the user
  // abandons the step-up. The visible `password` state is cleared at the step-up prompt.
  const pendingUnlock = useRef<UnlockContext | null>(null);

  const clearSecrets = (): void => {
    setPassword('');
    setConfirm('');
    setTotpCode('');
  };

  const finishGranted = async (session: GrantedLoginResponse, ctx: UnlockContext): Promise<void> => {
    // Access was GRANTED → open the local vault (so the encryption key is held in
    // memory — the source of truth for "Unlocked") AND pull-sync it from the server
    // (server → local, by revision) so a second device / reinstall reconstructs the
    // full vault. If the unlock fails, proceed LOCKED rather than claiming "Unlocked"
    // (fail closed); the pull is best-effort and never blocks the open local vault.
    let vaultUnlocked = false;
    try {
      await unlockAndPull(ctx.masterPassword, session, ctx.kdfSalt, ctx.kdfParams, ctx.username);
      vaultUnlocked = true;
    } catch {
      vaultUnlocked = false;
    }
    pendingUnlock.current = null;
    let enrollment: EnrollmentStatus | null = null;
    try {
      enrollment = await getEnrollmentStatus(session.sessionToken);
    } catch {
      enrollment = null; // best-effort; never block the unlock
    }
    setChallengeToken(null);
    clearSecrets();
    onAuthenticated({ token: session.sessionToken, enrollment, vaultUnlocked });
  };

  const doRegister = async (): Promise<void> => {
    // Registration authenticates but does NOT derive the vault key (zero-knowledge). Land
    // the user on the SIGN-IN step (username kept) to open the vault — that first sign-in
    // also captures the first typing-rhythm sample; the rest of onboarding (2FA + rhythm)
    // then runs in the vault. We intentionally do NOT auto-unlock here.
    await registerAccount(username, password);
    capture.reset();
    clearSecrets();
    setMode('login');
    setRegistered(true);
  };

  const doLogin = async (): Promise<void> => {
    // The captured keystroke timing is sent with the login request itself.
    const features = capture.takeSample();
    const masterPassword = password;
    const outcome = await loginAccount(username, masterPassword, features);
    const ctx: UnlockContext = {
      masterPassword,
      kdfSalt: outcome.kdfSalt,
      kdfParams: outcome.kdfParams,
      username,
    };
    if (outcome.kind === 'granted') {
      await finishGranted(outcome.session, ctx);
    } else {
      // Step-up required: keep the challenge and prompt for a TOTP code. Stash the
      // unlock context (needed to open + pull-sync the local vault once the step-up
      // passes) and clear the visible field — the step-up screen shows only the code.
      pendingUnlock.current = ctx;
      setChallengeToken(outcome.challengeToken);
      clearSecrets();
    }
  };

  const doStepUp = async (): Promise<void> => {
    if (challengeToken === null || pendingUnlock.current === null) {
      return;
    }
    const session = await completeStepUp({ challengeToken, code: totpCode });
    await finishGranted(session, pendingUnlock.current);
  };

  // Each action supplies its own error→message mapping so every outcome renders a
  // DISTINCT, non-leaking message (ADR-0012): login maps 401/403/429/network
  // separately; step-up reads a 401 as a bad code; register maps 409 (username
  // taken) / 400 / network distinctly instead of the raw "request failed" string.
  const run = (action: () => Promise<void>, mapError: (e: unknown) => string): void => {
    setError(null);
    setDenyRisk(null);
    setBusy(true);
    void action()
      .catch((e: unknown) => {
        capture.reset();
        clearSecrets();
        setError(mapError(e)); // the generic, non-leaking message (unchanged, ADR-0012)
        setDenyRisk(extractDenyRisk(e)); // null unless a dev/demo server sent a breakdown
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
    setDenyRisk(null);
    setRegistered(false);
    setChallengeToken(null);
    setShowPw(false);
    capture.reset();
    pendingUnlock.current = null;
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
            pendingUnlock.current = null;
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

      {/* Just-registered: nudge the first sign-in (which starts the rhythm enrolment). */}
      {!isRegister && registered && (
        <Banner className="mt-5" tone="success" title="Account created">
          Sign in to set up your security and open your vault.
        </Banner>
      )}

      {/* Continuous-auth spike-lock notice (presentation only; generic copy). */}
      {!isRegister && lockNotice === 'risk' && (
        <Banner className="mt-5" tone="info" title="Locked for your security">
          Please unlock again to continue. Your credentials stayed encrypted and safe.
        </Banner>
      )}

      {error !== null && <Banner className="mt-5" tone="error" title={error} />}
      {denyRisk !== null && <DenyExplanation risk={denyRisk} />}

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

        {isRegister && password.length > 0 && <PasswordGuidance strength={strength} />}

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
          disabled={busy || username.length === 0 || password.length === 0 || (isRegister && !strength.acceptable)}
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
