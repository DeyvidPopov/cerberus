// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api', () => ({
  setupTotp: vi.fn(),
  confirmTotp: vi.fn(),
}));
vi.mock('../../lib/tauri', () => ({ errorMessage: () => 'error' }));

import { confirmTotp, setupTotp } from '../../lib/api';
import { TotpEnrollment } from './TotpEnrollment';

const onConfirmed = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('TotpEnrollment nudge (Part A)', () => {
  it('prompts to set up, reveals the secret, and confirms the second factor', async () => {
    vi.mocked(setupTotp).mockResolvedValue({
      provisioningUri: 'otpauth://totp/Cerberus:alice?secret=ABC',
      secret: 'ABCDEFGH',
    });
    vi.mocked(confirmTotp).mockResolvedValue({ confirmed: true });

    render(<TotpEnrollment token="tok-1" onConfirmed={onConfirmed} />);

    // The nudge appears for an active-baseline user with no second factor.
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));

    // The secret is shown once for the authenticator app.
    expect(await screen.findByText('ABCDEFGH')).toBeTruthy();
    expect(setupTotp).toHaveBeenCalledWith('tok-1');

    fireEvent.change(screen.getByLabelText('Confirmation code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(confirmTotp).toHaveBeenCalledWith('tok-1', { code: '123456' });
      expect(onConfirmed).toHaveBeenCalledTimes(1);
    });
  });

  it('shows a retry message and does not confirm when the code is wrong', async () => {
    vi.mocked(setupTotp).mockResolvedValue({ provisioningUri: 'otpauth://x', secret: 'SECRET' });
    vi.mocked(confirmTotp).mockResolvedValue({ confirmed: false });

    render(<TotpEnrollment token="tok-1" onConfirmed={onConfirmed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    fireEvent.change(await screen.findByLabelText('Confirmation code'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
