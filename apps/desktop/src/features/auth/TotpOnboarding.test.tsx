// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Render the QR + verify the real setup/confirm flow without a backend or canvas.
vi.mock('qrcode', () => ({ toDataURL: vi.fn(async () => 'data:image/png;base64,AAAA') }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  setupTotp: vi.fn(),
  confirmTotp: vi.fn(),
}));
vi.mock('../../lib/tauri', () => ({ errorMessage: (e: unknown) => String(e) }));

import { confirmTotp, setupTotp } from '../../lib/api';
import { TotpOnboarding } from './TotpOnboarding';

const SETUP = { secret: 'JBSWY3DPEHPK3PXP', provisioningUri: 'otpauth://totp/Cerberus:demo?secret=JBSWY3DPEHPK3PXP' };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

function typeCode(code: string): void {
  const boxes = screen.getAllByLabelText(/Digit/u);
  code.split('').forEach((d, i) => {
    fireEvent.change(boxes[i] as HTMLInputElement, { target: { value: d } });
  });
}

describe('TotpOnboarding (mandatory 2FA setup)', () => {
  it('shows the formatted setup key + QR, then confirms with a 6-digit code (auto-submit)', async () => {
    vi.mocked(setupTotp).mockResolvedValue(SETUP);
    vi.mocked(confirmTotp).mockResolvedValue({ confirmed: true });
    const onConfirmed = vi.fn();
    render(<TotpOnboarding token="tok" onConfirmed={onConfirmed} onSignOut={vi.fn()} />);

    // The base32 secret is shown in groups of four, and the QR is rendered locally.
    await waitFor(() => {
      expect(screen.getByText(/JBSW Y3DP EHPK 3PXP/u)).toBeTruthy();
    });
    expect(screen.getByAltText(/setup QR/iu)).toBeTruthy();
    expect(screen.getAllByLabelText(/Digit/u).length).toBe(6);

    typeCode('123456');
    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(confirmTotp)).toHaveBeenCalledWith('tok', { code: '123456' });
  });

  it('a wrong code shows a generic error and stays on the step (never proceeds)', async () => {
    vi.mocked(setupTotp).mockResolvedValue(SETUP);
    vi.mocked(confirmTotp).mockRejectedValue(new Error('400'));
    const onConfirmed = vi.fn();
    render(<TotpOnboarding token="tok" onConfirmed={onConfirmed} onSignOut={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/JBSW Y3DP/u)).toBeTruthy();
    });
    typeCode('000000');
    await waitFor(() => {
      expect(screen.getByText(/did not match/iu)).toBeTruthy();
    });
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
