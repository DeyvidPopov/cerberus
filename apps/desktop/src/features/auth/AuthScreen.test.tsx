// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the orchestration layer so we can drive each login OUTCOME directly. The
// api module is only partially mocked: the real ApiError class is preserved so
// auth-errors' `instanceof ApiError` classification works against real instances.
vi.mock('../../lib/auth', () => ({
  loginAccount: vi.fn(),
  completeStepUp: vi.fn(),
  registerAccount: vi.fn(),
  unlockAndPull: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  getEnrollmentStatus: vi.fn(),
}));
vi.mock('../../lib/keystroke-capture', () => ({
  useKeystrokeCapture: () => ({ inputRef: () => undefined, takeSample: () => null, reset: () => undefined }),
}));

import { getEnrollmentStatus, ApiError } from '../../lib/api';
import { completeStepUp, loginAccount, registerAccount, unlockAndPull } from '../../lib/auth';
import { SecureCoreError } from '../../lib/secure-core';
import { AuthScreen } from './AuthScreen';

const onAuthenticated = vi.fn();
const KDF = { memoryKib: 1, iterations: 1, parallelism: 1 };

function renderLoginAndSubmit(): void {
  render(<AuthScreen onAuthenticated={onAuthenticated} />);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'master-pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEnrollmentStatus).mockResolvedValue({
    status: 'enrolling',
    samplesCollected: 1,
    samplesRequired: 10,
    featureSchemaVersion: 1,
  });
});

afterEach(() => {
  cleanup();
});

describe('AuthScreen — distinct login outcomes (Part A)', () => {
  it('granted → proceeds to the vault (onAuthenticated with the session token)', async () => {
    vi.mocked(loginAccount).mockResolvedValue({
      kind: 'granted',
      session: {
        status: 'granted',
        sessionToken: 'tok-1',
        expiresAt: '2026-01-01T00:00:00.000Z',
        wrappedVaultKey: 'QQ==',
        wrappedVaultKeyNonce: 'QQ==',
        device: { isNew: false },
      },
      kdfSalt: 'SALT',
      kdfParams: KDF,
    });
    renderLoginAndSubmit();
    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-1' }));
    });
    // A granted login opens the LOCAL vault AND pull-syncs it from the server — the
    // vault screen's single source of truth for "Unlocked".
    expect(unlockAndPull).toHaveBeenCalledWith(
      'master-pw',
      expect.objectContaining({ sessionToken: 'tok-1' }),
      'SALT',
      KDF,
      'alice', // the account's username scopes the per-account local vault file
    );
    expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ vaultUnlocked: true }));
  });

  it('registration flips to SIGN-IN (does not auto-unlock; zero-knowledge) and nudges the first sign-in', async () => {
    vi.mocked(registerAccount).mockResolvedValue();
    render(<AuthScreen onAuthenticated={onAuthenticated} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a vault' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
    // A password that clears the strength gate (≥12 chars, mixed, not common).
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'Str0ng-Master-Pass' } });
    fireEvent.change(screen.getByLabelText('Confirm master password'), { target: { value: 'Str0ng-Master-Pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));

    // It does NOT auto-authenticate/unlock — the user signs in to open the vault.
    await waitFor(() => {
      expect(screen.getByText('Account created')).toBeTruthy();
    });
    expect(registerAccount).toHaveBeenCalledWith('newuser', 'Str0ng-Master-Pass');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(unlockAndPull).not.toHaveBeenCalled();
    // The view is now the sign-in step (a "Log in" button), with the username kept.
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('newuser');
  });

  it('step_up_required → shows the TOTP prompt and drives the verify flow', async () => {
    vi.mocked(loginAccount).mockResolvedValue({
      kind: 'step_up',
      challengeToken: 'chal-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
      kdfSalt: 'SALT',
      kdfParams: KDF,
    });
    vi.mocked(completeStepUp).mockResolvedValue({
      status: 'granted',
      sessionToken: 'tok-stepup',
      expiresAt: '2026-01-01T00:00:00.000Z',
      wrappedVaultKey: 'QQ==',
      wrappedVaultKeyNonce: 'QQ==',
      device: { isNew: false },
    });
    renderLoginAndSubmit();

    // The step-up prompt appears (not a vault, not an error).
    const codeInput = await screen.findByLabelText('Authenticator code');
    expect(onAuthenticated).not.toHaveBeenCalled();

    // Completing the prompt drives the M9 verify flow with the held challenge.
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => {
      expect(completeStepUp).toHaveBeenCalledWith({ challengeToken: 'chal-1', code: '123456' });
      expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-stepup' }));
    });
    // The local vault is opened + pull-synced with the unlock context STASHED before
    // the step-up (the visible field was cleared when the prompt appeared), so the
    // post-step-up session is honestly Unlocked — not left locked or unlocked empty.
    expect(unlockAndPull).toHaveBeenCalledWith(
      'master-pw',
      expect.objectContaining({ sessionToken: 'tok-stepup' }),
      'SALT',
      KDF,
      'alice', // username threaded through the stashed unlock context
    );
    expect(onAuthenticated).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'tok-stepup', vaultUnlocked: true }),
    );
  });

  it('401 → "Incorrect username or master password"', async () => {
    vi.mocked(loginAccount).mockRejectedValue(new ApiError(401, 'invalid_credentials'));
    renderLoginAndSubmit();
    expect(await screen.findByText('Incorrect username or master password')).toBeTruthy();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('403 → "Access denied due to risk" and leaks no risk detail', async () => {
    vi.mocked(loginAccount).mockRejectedValue(new ApiError(403, 'denied'));
    renderLoginAndSubmit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Access denied due to risk');
    // PRIVACY: no signal/score/band detail anywhere in the DOM.
    expect(document.body.textContent ?? '').not.toMatch(
      /keystroke|mouse|geo|velocity|device|score|composite|band|signal/iu,
    );
  });

  it('403 WITH a demo breakdown → generic message PLUS a clearly-labelled demonstration panel', async () => {
    const risk = {
      composite: 0.85,
      threshold: 0.7,
      driver: 'New device',
      signals: [
        { label: 'Behavioral — typing rhythm', contribution: 0.5, reason: 'Typing rhythm deviates sharply from your enrolled profile' },
        { label: 'New device', contribution: 0.35, reason: 'Sign-in from a device we have not seen before' },
      ],
    };
    vi.mocked(loginAccount).mockRejectedValue(new ApiError(403, 'denied', { error: 'denied', risk }));
    renderLoginAndSubmit();

    // The PRIMARY, user-facing message is STILL the generic copy (unchanged).
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Access denied due to risk');

    // The demonstration panel appears with the real breakdown, clearly labelled non-production.
    await waitFor(() => {
      expect(screen.getByText(/Demonstration — why this was denied/iu)).toBeTruthy();
    });
    expect(screen.getByText(/production build never reveals/iu)).toBeTruthy();
    expect(screen.getByText('New device')).toBeTruthy();
    expect(screen.getByText(/device we have not seen/iu)).toBeTruthy();
  });

  it('network/CSP failure → "Couldn\'t reach the server" (distinct from an auth response)', async () => {
    vi.mocked(loginAccount).mockRejectedValue(new TypeError('Failed to fetch'));
    renderLoginAndSubmit();
    expect(await screen.findByText("Couldn't reach the server")).toBeTruthy();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('secure-core fault (Rust IPC) → distinct desktop-runtime message, not the generic fallback', async () => {
    // The reported "Tester" symptom: the local key-derivation IPC rejects. It must read
    // as a local-core problem (run/restart the desktop app), NOT a server/network error
    // and NOT the indistinguishable "Something went wrong".
    vi.mocked(loginAccount).mockRejectedValue(new SecureCoreError('failed', 'key derivation was interrupted'));
    renderLoginAndSubmit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/secure core/i);
    expect(alert.textContent).toMatch(/desktop app/i);
    expect(alert.textContent).not.toBe('Something went wrong. Please try again.');
    expect(alert.textContent).not.toBe("Couldn't reach the server");
    expect(onAuthenticated).not.toHaveBeenCalled();
    // PRIVACY: the underlying cause string is never shown to the user.
    expect(document.body.textContent ?? '').not.toContain('key derivation was interrupted');
  });

  it('register 409 → a clear "username taken" message (not the raw "request failed")', async () => {
    vi.mocked(registerAccount).mockRejectedValue(new ApiError(409, 'request to /auth/register failed'));
    render(<AuthScreen onAuthenticated={onAuthenticated} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a vault' })); // toggle to register
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'scottlaw' } });
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'Str0ng-Master-Pass' } });
    fireEvent.change(screen.getByLabelText('Confirm master password'), { target: { value: 'Str0ng-Master-Pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(await screen.findByText('That username is already taken. Try another one.')).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').not.toContain('request to /auth/register failed');
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('registration gates "Create vault" on a strong master password + shows guidance', async () => {
    render(<AuthScreen onAuthenticated={onAuthenticated} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create a vault' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });

    // A weak password: the requirements checklist appears and the submit stays disabled.
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'weak' } });
    expect(screen.getByText('At least 12 characters')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create vault' }) as HTMLButtonElement).disabled).toBe(true);

    // A strong password clears the gate.
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'Str0ng-Master-Pass' } });
    fireEvent.change(screen.getByLabelText('Confirm master password'), { target: { value: 'Str0ng-Master-Pass' } });
    expect((screen.getByRole('button', { name: 'Create vault' }) as HTMLButtonElement).disabled).toBe(false);
    expect(registerAccount).not.toHaveBeenCalled(); // not submitted yet — just enabled
  });
});
