// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the IPC/transport deps so the view renders without a running app. The lock
// state under test is driven purely by `session.vaultUnlocked`.
vi.mock('../../lib/tauri', () => ({
  listCredentials: vi.fn(),
  getCredential: vi.fn(),
  addCredential: vi.fn(),
  updateCredential: vi.fn(),
  deleteCredential: vi.fn(),
  lock: vi.fn().mockResolvedValue(undefined),
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../../lib/ws', () => ({
  openContinuousAuth: vi.fn(() => ({ sendWindow: vi.fn(), close: vi.fn() })),
}));
vi.mock('../../lib/mouse-capture', () => ({
  attachMouseCapture: vi.fn(() => () => undefined),
}));
vi.mock('../../lib/api', () => ({
  getTotpStatus: vi.fn().mockResolvedValue({ confirmed: true }),
}));
vi.mock('./TotpEnrollment', () => ({ TotpEnrollment: () => null }));

import { listCredentials } from '../../lib/tauri';
import { VaultView } from './VaultView';

const onLock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('VaultView — lock state honesty (single source of truth)', () => {
  it('keys NOT held → "Locked" pill, no credential query, no Add, calm locked panel', () => {
    // The post-registration state: authenticated but vaultUnlocked: false.
    render(
      <VaultView onLock={onLock} session={{ token: null, enrollment: null, vaultUnlocked: false }} />,
    );
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(screen.queryByText('Unlocked')).toBeNull();
    // Locked ⇒ never query the local vault (which would surface "vault is locked").
    expect(listCredentials).not.toHaveBeenCalled();
    // No Add affordance while locked; the calm locked panel is shown instead.
    expect(screen.queryByRole('button', { name: 'Add credential' })).toBeNull();
    expect(screen.getByText('Your vault is locked')).toBeTruthy();
    // PRIVACY/UX: no contradictory "vault is locked" ERROR beneath an Unlocked pill.
    expect(screen.queryByText('vault is locked')).toBeNull();
  });

  it('keys held → "Unlocked" pill, queries credentials, no locked panel', async () => {
    vi.mocked(listCredentials).mockResolvedValue([]);
    render(
      <VaultView onLock={onLock} session={{ token: 'tok', enrollment: null, vaultUnlocked: true }} />,
    );
    expect(screen.getByText('Unlocked')).toBeTruthy();
    expect(screen.queryByText('Locked')).toBeNull();
    await waitFor(() => {
      expect(listCredentials).toHaveBeenCalled();
    });
    expect(screen.queryByText('Your vault is locked')).toBeNull();
  });
});
