import type {
  Credential,
  CredentialInput,
  CredentialSummary,
  EnrollmentStatus,
} from '@cerberus/shared-types';
import { useEffect, useState } from 'react';

import type { AuthenticatedSession } from '../auth/AuthScreen';
import {
  addCredential,
  deleteCredential,
  errorMessage,
  getCredential,
  listCredentials,
  lock,
  updateCredential,
} from '../../lib/tauri';

const EMPTY_INPUT: CredentialInput = {
  name: '',
  username: '',
  password: '',
  url: '',
  notes: '',
};

interface VaultViewProps {
  onLock: () => void;
  session: AuthenticatedSession;
}

// Behavioral enrollment progress (Milestone 6): a progress indicator while the
// typing profile is being built, and a confirmation once it is active. The
// status carries only counts — never a raw feature vector (PROJECT.md §5).
function EnrollmentBanner({ enrollment }: { enrollment: EnrollmentStatus }) {
  if (enrollment.status === 'active') {
    return (
      <p className="enrollment" role="status">
        ✓ Typing profile active
      </p>
    );
  }
  return (
    <p className="enrollment" role="status">
      Building typing profile: {enrollment.samplesCollected}/{enrollment.samplesRequired}
    </p>
  );
}

// Credential plaintext (the password) is only pulled into the webview on demand
// — when revealing or editing a single item — and is never persisted to browser
// storage (PROJECT.md §4.2). The list shows only id/name/username.
export function VaultView({ onLock, session }: VaultViewProps) {
  const [items, setItems] = useState<CredentialSummary[]>([]);
  const [form, setForm] = useState<CredentialInput>(EMPTY_INPUT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Credential | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void listCredentials()
      .then(setItems)
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  useEffect(refresh, []);

  const resetForm = (): void => {
    setForm(EMPTY_INPUT);
    setEditingId(null);
  };

  const save = (): void => {
    setError(null);
    const action =
      editingId === null
        ? addCredential(form).then(() => undefined)
        : updateCredential(editingId, form);
    void action
      .then(() => {
        resetForm();
        refresh();
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const startEdit = (id: string): void => {
    setError(null);
    void getCredential(id)
      .then((c) => {
        setEditingId(c.id);
        setForm({
          name: c.name,
          username: c.username,
          password: c.password,
          url: c.url,
          notes: c.notes,
        });
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const reveal = (id: string): void => {
    setError(null);
    void getCredential(id)
      .then(setRevealed)
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const remove = (id: string): void => {
    setError(null);
    void deleteCredential(id)
      .then(() => {
        if (editingId === id) {
          resetForm();
        }
        if (revealed?.id === id) {
          setRevealed(null);
        }
        refresh();
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const doLock = (): void => {
    void lock()
      .catch(() => undefined)
      .finally(onLock);
  };

  const setField = (field: keyof CredentialInput, value: string): void => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <main className="screen">
      <header className="vault-header">
        <h1>Vault</h1>
        <button type="button" onClick={doLock}>
          Lock
        </button>
      </header>

      {session.enrollment !== null && <EnrollmentBanner enrollment={session.enrollment} />}

      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <section>
        <h2>{editingId === null ? 'Add credential' : 'Edit credential'}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            aria-label="Name"
            placeholder="Name"
            value={form.name}
            onChange={(e) => {
              setField('name', e.target.value);
            }}
          />
          <input
            aria-label="Username"
            placeholder="Username"
            value={form.username}
            onChange={(e) => {
              setField('username', e.target.value);
            }}
          />
          <input
            aria-label="Password"
            placeholder="Password"
            type="password"
            value={form.password}
            onChange={(e) => {
              setField('password', e.target.value);
            }}
          />
          <input
            aria-label="URL"
            placeholder="URL"
            value={form.url}
            onChange={(e) => {
              setField('url', e.target.value);
            }}
          />
          <textarea
            aria-label="Notes"
            placeholder="Notes"
            value={form.notes}
            onChange={(e) => {
              setField('notes', e.target.value);
            }}
          />
          <div>
            <button type="submit" disabled={form.name.length === 0}>
              {editingId === null ? 'Add' : 'Save'}
            </button>
            {editingId !== null && (
              <button type="button" onClick={resetForm}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </section>

      <section>
        <h2>Credentials ({items.length})</h2>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <span>
                <strong>{item.name}</strong> — {item.username}
              </span>
              <span className="actions">
                <button type="button" onClick={() => { reveal(item.id); }}>
                  Reveal
                </button>
                <button type="button" onClick={() => { startEdit(item.id); }}>
                  Edit
                </button>
                <button type="button" onClick={() => { remove(item.id); }}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {revealed !== null && (
        <section className="revealed">
          <h2>{revealed.name}</h2>
          <dl>
            <dt>Username</dt>
            <dd>{revealed.username}</dd>
            <dt>Password</dt>
            <dd>
              <code>{revealed.password}</code>
            </dd>
            {revealed.url.length > 0 && (
              <>
                <dt>URL</dt>
                <dd>{revealed.url}</dd>
              </>
            )}
            {revealed.notes.length > 0 && (
              <>
                <dt>Notes</dt>
                <dd>{revealed.notes}</dd>
              </>
            )}
          </dl>
          <button
            type="button"
            onClick={() => {
              setRevealed(null);
            }}
          >
            Hide
          </button>
        </section>
      )}
    </main>
  );
}
