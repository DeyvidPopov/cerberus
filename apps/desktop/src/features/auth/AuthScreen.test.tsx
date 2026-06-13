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
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  getEnrollmentStatus: vi.fn(),
}));
vi.mock('../../lib/keystroke-capture', () => ({
  useKeystrokeCapture: () => ({ inputRef: () => undefined, takeSample: () => null, reset: () => undefined }),
}));

import { getEnrollmentStatus, ApiError } from '../../lib/api';
import { completeStepUp, loginAccount } from '../../lib/auth';
import { AuthScreen } from './AuthScreen';

const onAuthenticated = vi.fn();

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
    });
    renderLoginAndSubmit();
    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-1' }));
    });
  });

  it('step_up_required → shows the TOTP prompt and drives the verify flow', async () => {
    vi.mocked(loginAccount).mockResolvedValue({
      kind: 'step_up',
      challengeToken: 'chal-1',
      expiresAt: '2026-01-01T00:00:00.000Z',
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

  it('network/CSP failure → "Couldn\'t reach the server" (distinct from an auth response)', async () => {
    vi.mocked(loginAccount).mockRejectedValue(new TypeError('Failed to fetch'));
    renderLoginAndSubmit();
    expect(await screen.findByText("Couldn't reach the server")).toBeTruthy();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});
