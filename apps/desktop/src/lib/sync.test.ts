import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  listVaultItems: vi.fn(),
  createVaultItem: vi.fn(),
  updateVaultItem: vi.fn(),
}));
vi.mock('./tauri', () => ({
  sealCredential: vi.fn(),
  openCredential: vi.fn(),
}));

import { createVaultItem, listVaultItems, updateVaultItem } from './api';
import { pullItems, pushNewItem, pushUpdatedItem, type SyncContext } from './sync';
import { openCredential, sealCredential } from './tauri';

const ctx: SyncContext = {
  token: 'tok',
  masterPassword: 'master-pw',
  kdfSalt: 'salt',
  kdfParams: { memoryKib: 1, iterations: 1, parallelism: 1 },
  wrappedVaultKey: 'wrapped',
  wrappedVaultKeyNonce: 'wrapped-nonce',
};

const credential = { name: 'GitHub', username: 'octocat', password: 'pw', url: '', notes: '' };

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
