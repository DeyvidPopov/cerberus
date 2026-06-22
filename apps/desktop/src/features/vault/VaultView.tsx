import type {
  Credential,
  CredentialInput,
  CredentialSummary,
  EnrollmentStatus,
} from '@cerberus/shared-types';
import { useEffect, useState } from 'react';

import { BrandMark, EyeIcon, LockIcon, PencilIcon, PlusIcon, TrashIcon } from '../../components/icons';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { WaveBars } from '../../components/ui/wave';
import { cn } from '../../lib/cn';
import type { AuthenticatedSession, LockReason } from '../auth/AuthScreen';
import { getTotpStatus } from '../../lib/api';
import { attachMouseCapture } from '../../lib/mouse-capture';
import {
  addCredential,
  deleteCredential,
  errorMessage,
  getCredential,
  listCredentials,
  lock,
  updateCredential,
} from '../../lib/tauri';
import { openContinuousAuth } from '../../lib/ws';
import { RiskInspector } from './RiskInspector';
import { TotpEnrollment } from './TotpEnrollment';

const EMPTY_INPUT: CredentialInput = {
  name: '',
  username: '',
  password: '',
  url: '',
  notes: '',
};

interface VaultViewProps {
  /** `reason` is presentation only: 'risk' ⇒ a continuous-auth spike (show the lock notice). */
  onLock: (reason?: LockReason | 'manual') => void;
  session: AuthenticatedSession;
}

// Behavioral enrollment progress (Milestone 6): a progress indicator while the
// typing profile is being built, and a confirmation once it is active. The status
// carries only counts — never a raw feature vector (PROJECT.md §5). Restyled to the
// design language (ADR-0015): a brass "learning your rhythm" banner with a wave +
// progress bar while enrolling; a calm confirmation chip once active.
function EnrollmentBanner({ enrollment }: { enrollment: EnrollmentStatus }) {
  if (enrollment.status === 'active') {
    return (
      <div
        role="status"
        className="flex items-center gap-2.5 rounded-xl border border-ok/30 bg-ok/[0.08] px-[14px] py-2.5 text-[13px] font-medium text-ok"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-ok" /> Typing profile active
      </div>
    );
  }
  const pct = Math.min(100, Math.round((enrollment.samplesCollected / enrollment.samplesRequired) * 100));
  return (
    <div
      role="status"
      className="flex items-center gap-[18px] rounded-lg border border-accent/25 bg-gradient-to-r from-accent/10 to-accent/[0.03] px-[18px] py-[15px]"
    >
      <div className="hidden h-10 w-[120px] flex-none sm:block">
        <WaveBars count={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-[#f1c281]">
          Building your typing profile — {enrollment.samplesCollected} of {enrollment.samplesRequired}
        </div>
        <div className="mt-0.5 text-[12.5px] text-muted">
          Cerberus is learning your typing rhythm to protect your vault.
        </div>
        <div className="mt-2.5 h-[5px] overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent-lo to-accent-hi transition-[width] duration-500"
            style={{ width: `${String(pct)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function letterTile(name: string): string {
  return (name.trim()[0] ?? '•').toUpperCase();
}

// Shown when the vault has no encryption key held in memory (e.g. straight after
// registration, which authenticates but does not derive the vault key). The header
// pill already reads "Locked"; this is the calm call-to-action, not a duplicate
// status banner — and it replaces the old behaviour where a failed credential fetch
// surfaced a contradictory "vault is locked" ERROR beneath an "Unlocked" pill.
function LockedVault({ onReturn }: { onReturn: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="flex h-[58px] w-[58px] items-center justify-center rounded-2xl border border-line2 bg-white/[0.04] text-muted2">
        <LockIcon size={26} />
      </div>
      <h2 className="mt-5 font-display text-xl font-semibold tracking-[-0.01em]">Your vault is locked</h2>
      <p className="mt-2 max-w-[340px] text-[13.5px] leading-[1.55] text-muted">
        Log in with your master password to unlock it. Your credentials stay encrypted until then.
      </p>
      <Button className="mt-6" onClick={onReturn}>
        Log in to unlock
      </Button>
    </div>
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
  // null = unknown/not-applicable; false = needs a nudge; true = already enrolled.
  const [totpConfirmed, setTotpConfirmed] = useState<boolean | null>(null);

  // THE single source of truth for the vault's lock state: whether the encryption
  // key is held in memory (set when a granted login opened the local vault). The
  // pill, the Add affordance, and the data fetches all read this one value, so they
  // can never disagree. Registration authenticates but does not derive the key, so
  // that state is honestly LOCKED.
  const vaultUnlocked = session.vaultUnlocked;

  const refresh = (): void => {
    if (!vaultUnlocked) {
      return; // locked → no key held; never query (would only yield "vault is locked")
    }
    void listCredentials()
      .then(setItems)
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  useEffect(refresh, [vaultUnlocked]);

  // Once the typing profile is active, check whether a second factor exists; if
  // not, surface the enrollment nudge (fail-closed step-up would otherwise deny a
  // no-TOTP user on a risky login — ADR-0012). Best-effort: never blocks the vault.
  const token = session.token;
  const baselineActive = session.enrollment?.status === 'active';
  useEffect(() => {
    if (token === null || !baselineActive) {
      return;
    }
    void getTotpStatus(token)
      .then((s) => {
        setTotpConfirmed(s.confirmed);
      })
      .catch(() => {
        setTotpConfirmed(null); // unknown → no nudge, never block
      });
  }, [token, baselineActive]);

  // Continuous authentication (ADR-0013): while unlocked, stream mouse-dynamics
  // windows to the server. On a server-commanded lock (risk spike) zeroize the keys
  // via the M3 lock path and return to the unlock screen — re-unlock re-runs the M9
  // login risk evaluation. Capture reads only pointer geometry/timing, never content.
  useEffect(() => {
    if (token === null || !vaultUnlocked) {
      return; // only stream/score while the vault is actually open (keys held)
    }
    let locked = false;
    const client = openContinuousAuth(token, {
      onLocked: () => {
        if (locked) {
          return;
        }
        locked = true;
        void lock()
          .catch(() => undefined)
          .finally(() => {
            onLock('risk');
          });
      },
    });
    const detach = attachMouseCapture(window, (features) => {
      client.sendWindow(features);
    });
    return () => {
      detach();
      client.close();
    };
  }, [token, vaultUnlocked, onLock]);

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
      .finally(() => {
        onLock('manual');
      });
  };

  const setField = (field: keyof CredentialInput, value: string): void => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const iconBtn =
    'flex h-9 w-9 items-center justify-center rounded-[9px] text-muted2 hover:text-fg hover:bg-white/[0.06] transition-colors';

  return (
    <div className="surface-card flex h-[min(800px,92vh)] w-[min(1240px,96vw)] flex-col overflow-hidden rounded-2xl border border-line shadow-card animate-fadeUp">
      {/* TOP BAR */}
      <header className="flex h-16 flex-none items-center gap-3 border-b border-line2 px-[22px]">
        <BrandMark size={26} />
        <span className="font-display text-xl font-semibold tracking-[-0.01em]">Vault</span>
        <div className="flex-1" />
        {vaultUnlocked ? (
          <span className="flex items-center gap-[6px] rounded-full border border-ok/25 bg-ok/[0.08] py-[5px] pl-[9px] pr-[11px]">
            <span className="h-[7px] w-[7px] animate-glow rounded-full bg-ok shadow-[0_0_8px_#5bbf92]" />
            <span className="text-[11.5px] font-medium text-ok">Unlocked</span>
          </span>
        ) : (
          <span className="flex items-center gap-[6px] rounded-full border border-line2 bg-white/[0.04] py-[5px] pl-[9px] pr-[11px] text-muted2">
            <LockIcon size={12} />
            <span className="text-[11.5px] font-medium">Locked</span>
          </span>
        )}
        <Button variant="icon" size="icon" onClick={doLock} title="Lock vault" aria-label="Lock vault">
          <LockIcon size={17} />
        </Button>
      </header>

      {!vaultUnlocked ? (
        <LockedVault
          onReturn={() => {
            onLock('manual');
          }}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
        {/* BANNERS */}
        <div className="flex flex-col gap-3 px-[18px] pt-4 empty:hidden">
          {session.enrollment !== null && <EnrollmentBanner enrollment={session.enrollment} />}
          {token !== null && baselineActive && totpConfirmed === false && (
            <TotpEnrollment
              token={token}
              onConfirmed={() => {
                setTotpConfirmed(true);
              }}
            />
          )}
          {error !== null && <Banner tone="error" title={error} />}
        </div>

        {/* PANES */}
        <div className="flex min-h-0 flex-1">
          {/* ITEM LIST */}
          <div className="flex w-[336px] flex-none flex-col border-r border-line2">
            <div className="flex items-center justify-between px-[18px] pb-2 pt-4">
              <span className="text-[11px] font-semibold tracking-[0.06em] text-faint">
                CREDENTIALS ({items.length})
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={resetForm}
                title="Add credential"
                aria-label="Add credential"
              >
                <PlusIcon size={17} />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
              {items.length === 0 ? (
                <div className="px-5 py-16 text-center">
                  <div className="text-[13.5px] font-semibold text-muted">No credentials yet</div>
                  <div className="mt-1 text-[12.5px] text-faint">
                    Add your first login on the right — Cerberus keeps it encrypted.
                  </div>
                </div>
              ) : (
                items.map((item) => {
                  const active = revealed?.id === item.id || editingId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        'group mb-[3px] flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors',
                        active
                          ? 'border-accent/30 bg-accent/[0.06]'
                          : 'border-transparent hover:border-line hover:bg-white/[0.03]',
                      )}
                    >
                      <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[10px] bg-elevated font-display text-[13px] font-bold text-accent">
                        {letterTile(item.name)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          reveal(item.id);
                        }}
                        className="min-w-0 flex-1 text-left"
                        title="Reveal"
                        aria-label={`Reveal ${item.name}`}
                      >
                        <span className="block truncate text-[13.5px] font-semibold text-fg">{item.name}</span>
                        <span className="block truncate text-[12px] text-muted2">{item.username}</span>
                      </button>
                      <button
                        type="button"
                        className={iconBtn}
                        onClick={() => {
                          reveal(item.id);
                        }}
                        title="Reveal"
                        aria-label="Reveal"
                      >
                        <EyeIcon size={16} />
                      </button>
                      <button
                        type="button"
                        className={iconBtn}
                        onClick={() => {
                          startEdit(item.id);
                        }}
                        title="Edit"
                        aria-label="Edit"
                      >
                        <PencilIcon size={16} />
                      </button>
                      <button
                        type="button"
                        className={cn(iconBtn, 'hover:text-danger')}
                        onClick={() => {
                          remove(item.id);
                        }}
                        title="Delete"
                        aria-label="Delete"
                      >
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* DETAIL: reveal card (if any) + the add/edit form */}
          <div className="min-h-0 flex-1 overflow-y-auto p-[26px]">
            {revealed !== null && (
              <section className="surface-elevated mb-6 max-w-[560px] rounded-xl border border-line p-6">
                <div className="flex items-start gap-3.5">
                  <span className="flex h-[50px] w-[50px] flex-none items-center justify-center rounded-[13px] bg-elevated font-display text-sm font-bold text-accent">
                    {letterTile(revealed.name)}
                  </span>
                  <h2 className="flex-1 pt-1 font-display text-[21px] font-semibold tracking-[-0.01em]">
                    {revealed.name}
                  </h2>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRevealed(null);
                    }}
                  >
                    Hide
                  </Button>
                </div>
                <dl className="mt-5 flex flex-col gap-5">
                  <div>
                    <dt className="text-[11.5px] text-muted2">Username</dt>
                    <dd className="mt-1 text-sm font-medium text-fg">{revealed.username || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[11.5px] text-muted2">Password</dt>
                    <dd className="mt-1 font-mono text-sm text-fg">
                      <code>{revealed.password}</code>
                    </dd>
                  </div>
                  {revealed.url.length > 0 && (
                    <div>
                      <dt className="text-[11.5px] text-muted2">Website</dt>
                      <dd className="mt-1 text-sm text-fg">{revealed.url}</dd>
                    </div>
                  )}
                  {revealed.notes.length > 0 && (
                    <div>
                      <dt className="text-[11.5px] text-muted2">Notes</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted">
                        {revealed.notes}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
            )}

            <section className="surface-elevated max-w-[560px] rounded-xl border border-line p-6">
              <h2 className="font-display text-lg font-semibold tracking-[-0.01em]">
                {editingId === null ? 'Add credential' : 'Edit credential'}
              </h2>
              <form
                className="mt-5 flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  save();
                }}
              >
                <Field label="Name">
                  <Input
                    aria-label="Name"
                    placeholder="e.g. GitHub"
                    value={form.name}
                    onChange={(e) => {
                      setField('name', e.target.value);
                    }}
                  />
                </Field>
                <Field label="Username">
                  <Input
                    aria-label="Username"
                    placeholder="you@example.com"
                    value={form.username}
                    onChange={(e) => {
                      setField('username', e.target.value);
                    }}
                  />
                </Field>
                <Field label="Password">
                  <Input
                    aria-label="Password"
                    placeholder="••••••••••••"
                    type="password"
                    className="font-mono"
                    value={form.password}
                    onChange={(e) => {
                      setField('password', e.target.value);
                    }}
                  />
                </Field>
                <Field label="URL">
                  <Input
                    aria-label="URL"
                    placeholder="https://…"
                    value={form.url}
                    onChange={(e) => {
                      setField('url', e.target.value);
                    }}
                  />
                </Field>
                <label className="block">
                  <span className="block text-xs font-medium text-muted">Notes</span>
                  <textarea
                    aria-label="Notes"
                    placeholder="Anything else to remember…"
                    rows={3}
                    className="mt-[7px] w-full resize-none rounded-[11px] border border-white/10 bg-field px-[14px] py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
                    value={form.notes}
                    onChange={(e) => {
                      setField('notes', e.target.value);
                    }}
                  />
                </label>
                <div className="flex items-center gap-2 pt-1">
                  <Button type="submit" size="sm" disabled={form.name.length === 0}>
                    {editingId === null ? 'Add credential' : 'Save changes'}
                  </Button>
                  {editingId !== null && (
                    <Button type="button" variant="secondary" size="sm" onClick={resetForm}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            </section>

            {/* DEMONSTRATION / RESEARCH affordance — server-gated on a step-up. */}
            {token !== null && <RiskInspector token={token} />}
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
