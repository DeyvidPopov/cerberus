import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  listVaultItems: vi.fn(),
  createVaultItem: vi.fn(),
  updateVaultItem: vi.fn(),
}));
vi.mock('./tauri', () => ({
  sealCredential: vi.fn(),
  openCredential: vi.fn(),
  syncPullMerge: vi.fn(),
}));

import { createVaultItem, listVaultItems, updateVaultItem } from './api';
import { pullItems, pushNewItem, pushUpdatedItem, syncPullOnUnlock, type SyncContext } from './sync';
import { openCredential, sealCredential, syncPullMerge } from './tauri';

const ctx: SyncContext = {
  token: 'tok',
  masterPassword: 'master-pw',
  kdfSalt: 'salt',
  kdfParams: { memoryKib: 1, iterations: 1, parallelism: 1 },
  wrappedVaultKey: 'wrapped',
  wrappedVaultKeyNonce: 'wrapped-nonce',
};

const credential = {
  name: 'GitHub',
  username: 'octocat',
  password: 'pw',
  url: '',
  notes: '',
  itemType: 'login' as const,
  favourite: false,
  category: '',
  otpSecret: '',
  passwordUpdatedAt: '',
  cardNumber: '',
  cardExpiry: '',
  cardCvv: '',
  cardHolder: '',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pullItems', () => {
  it('lists opaque blobs and decrypts each via Rust', async () => {
    vi.mocked(listVaultItems).mockResolvedValue([
      {
        id: 'id-1',
        ciphertext: 'ct',
        nonce: 'nc',
        itemType: 'login',
        revision: 2,
        createdAt: 'x',
        updatedAt: 'y',
      },
    ]);
    vi.mocked(openCredential).mockResolvedValue(JSON.stringify(credential));

    const items = await pullItems(ctx);

    expect(items).toEqual([{ id: 'id-1', revision: 2, data: credential }]);
    expect(openCredential).toHaveBeenCalledWith(
      expect.objectContaining({ ciphertext: 'ct', nonce: 'nc', masterPassword: 'master-pw' }),
    );
  });
});

describe('syncPullOnUnlock', () => {
  it('lists the server items and hands them to Rust to decrypt + merge by revision', async () => {
    vi.mocked(listVaultItems).mockResolvedValue([
      { id: 'a', ciphertext: 'ctA', nonce: 'ncA', itemType: 'login', revision: 3, createdAt: 'x', updatedAt: 'y' },
      { id: 'b', ciphertext: 'ctB', nonce: 'ncB', itemType: 'login', revision: 1, createdAt: 'x', updatedAt: 'y' },
    ]);
    vi.mocked(syncPullMerge).mockResolvedValue({ added: 2, updated: 0, kept: 0, skipped: 0 });

    const outcome = await syncPullOnUnlock(ctx);

    expect(outcome).toEqual({ added: 2, updated: 0, kept: 0, skipped: 0 });
    // The plaintext stays in Rust — TS only forwards the opaque blobs + revisions.
    expect(syncPullMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        masterPassword: 'master-pw',
        kdfSalt: 'salt',
        wrappedVaultKey: 'wrapped',
        wrappedVaultKeyNonce: 'wrapped-nonce',
        items: [
          { id: 'a', revision: 3, ciphertext: 'ctA', nonce: 'ncA' },
          { id: 'b', revision: 1, ciphertext: 'ctB', nonce: 'ncB' },
        ],
      }),
    );
  });
});

describe('pushNewItem', () => {
  it('seals the credential then stores the opaque blob', async () => {
    vi.mocked(sealCredential).mockResolvedValue({ ciphertext: 'ct', nonce: 'nc' });
    vi.mocked(createVaultItem).mockResolvedValue({ id: 'id-1', revision: 1, updatedAt: 'x' });

    const revision = await pushNewItem(ctx, 'id-1', credential);

    expect(revision).toBe(1);
    expect(sealCredential).toHaveBeenCalledWith(
      expect.objectContaining({ plaintext: JSON.stringify(credential) }),
    );
    expect(createVaultItem).toHaveBeenCalledWith('tok', {
      id: 'id-1',
      ciphertext: 'ct',
      nonce: 'nc',
      itemType: 'login',
    });
  });
});

describe('pushUpdatedItem', () => {
  it('propagates a revision conflict instead of silently overwriting', async () => {
    vi.mocked(sealCredential).mockResolvedValue({ ciphertext: 'ct', nonce: 'nc' });
    vi.mocked(updateVaultItem).mockRejectedValue(new Error('409 revision_conflict'));

    await expect(pushUpdatedItem(ctx, 'id-1', credential, 1)).rejects.toThrow();
  });
});
