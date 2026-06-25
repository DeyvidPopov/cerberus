// @vitest-environment jsdom
import type { Credential, CredentialSummary } from '@cerberus/shared-types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { getCredential, listCredentials } from '../../lib/tauri';
import { VaultView } from './VaultView';

const onLock = vi.fn();

const UNLOCKED = { token: 'tok', enrollment: null, vaultUnlocked: true } as const;
const SUMMARIES: CredentialSummary[] = [
  { id: 'hulu', name: 'Hulu', username: 'scott@gmail.com', url: 'https://hulu.com', itemType: 'login', favourite: true, category: 'Streaming', hasOtp: true },
  { id: 'visa', name: 'Personal Visa', username: '', url: '', itemType: 'card', favourite: false, category: 'Important', hasOtp: false },
  { id: 'note1', name: 'Recovery codes', username: '', url: '', itemType: 'note', favourite: false, category: '', hasOtp: false },
];
const HULU: Credential = {
  id: 'hulu', name: 'Hulu', username: 'scott@gmail.com', password: 'pw', url: 'https://hulu.com', notes: '',
  itemType: 'login', favourite: true, category: 'Streaming', otpSecret: '', passwordUpdatedAt: '',
  cardNumber: '', cardExpiry: '', cardCvv: '', cardHolder: '',
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('VaultView — lock state honesty (single source of truth)', () => {
  it('keys NOT held → calm locked screen, no "Protected" pill, no credential query', () => {
    // The post-registration state: authenticated but vaultUnlocked: false.
    render(
      <VaultView onLock={onLock} session={{ token: null, enrollment: null, vaultUnlocked: false }} />,
    );
    // The locked screen — never the "Protected" (unlocked) pill.
    expect(screen.getByText('Your vault is locked')).toBeTruthy();
    expect(screen.queryByText('Protected')).toBeNull();
    // Locked ⇒ never query the local vault (which would surface "vault is locked").
    expect(listCredentials).not.toHaveBeenCalled();
    // The calm call-to-action, not a vault with items.
    expect(screen.getByRole('button', { name: 'Log in to unlock' })).toBeTruthy();
    // PRIVACY/UX: no contradictory "vault is locked" ERROR text.
    expect(screen.queryByText('vault is locked')).toBeNull();
  });

  it('keys held → "Protected" pill, queries credentials, no locked screen', async () => {
    vi.mocked(listCredentials).mockResolvedValue([]);
    render(
      <VaultView onLock={onLock} session={{ token: 'tok', enrollment: null, vaultUnlocked: true }} />,
    );
    // Unlocked vault: the "Protected" status, the real list query, no locked screen.
    expect(screen.getByText('Protected')).toBeTruthy();
    await waitFor(() => {
      expect(listCredentials).toHaveBeenCalled();
    });
    expect(screen.queryByText('Your vault is locked')).toBeNull();
  });
});

describe('VaultView — redesigned vault (nav, search, detail)', () => {
  it('filters by sidebar section (logins / cards / favourites)', async () => {
    vi.mocked(listCredentials).mockResolvedValue(SUMMARIES);
    render(<VaultView onLock={onLock} session={UNLOCKED} />);

    // Logins by default → only the login item; the card/note live in other sections.
    await waitFor(() => {
      expect(screen.getByText('Hulu')).toBeTruthy();
    });
    expect(screen.queryByText('Personal Visa')).toBeNull();

    // Credit cards → the card, not the login.
    fireEvent.click(screen.getByText('Credit cards'));
    expect(screen.getByText('Personal Visa')).toBeTruthy();
    expect(screen.queryByText('Hulu')).toBeNull();

    // Favourites → the favourited login.
    fireEvent.click(screen.getByText('Favourites'));
    expect(screen.getByText('Hulu')).toBeTruthy();
    expect(screen.queryByText('Personal Visa')).toBeNull();
  });

  it('selecting an item opens its detail (website + username from the real credential)', async () => {
    vi.mocked(listCredentials).mockResolvedValue(SUMMARIES);
    vi.mocked(getCredential).mockResolvedValue(HULU);
    render(<VaultView onLock={onLock} session={UNLOCKED} />);

    await waitFor(() => {
      expect(screen.getByText('Hulu')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Hulu'));

    await waitFor(() => {
      expect(screen.getByText('scott@gmail.com')).toBeTruthy(); // username in the detail pane
    });
    expect(screen.getByText('https://hulu.com')).toBeTruthy(); // website
    expect(getCredential).toHaveBeenCalledWith('hulu');
  });

  it('search narrows the current section', async () => {
    vi.mocked(listCredentials).mockResolvedValue(SUMMARIES);
    render(<VaultView onLock={onLock} session={UNLOCKED} />);
    await waitFor(() => {
      expect(screen.getByText('Hulu')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Search vault'), { target: { value: 'zzz' } });
    expect(screen.queryByText('Hulu')).toBeNull();
  });
});
