import type {
  Credential,
  CredentialInput,
  CredentialSummary,
  EnrollmentStatus,
  ItemType,
} from '@cerberus/shared-types';
import { useEffect, useMemo, useState } from 'react';

import {
  AlertIcon,
  BrandMark,
  CheckIcon,
  CopyIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  HelpIcon,
  KeyIcon,
  LockIcon,
  NoteIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  StarFilledIcon,
  StarIcon,
  TrashIcon,
} from '../../components/icons';
import { Banner } from '../../components/ui/banner';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/label';
import { Input } from '../../components/ui/input';
import { WaveBars } from '../../components/ui/wave';
import { cn } from '../../lib/cn';
import type { AuthenticatedSession, LockReason } from '../auth/AuthScreen';
import { getTotpStatus } from '../../lib/api';
import { isValidOtpSecret } from '../../lib/otp';
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
import { RiskDashboard } from '../inspector/RiskDashboard';
import { Onboarding } from '../auth/Onboarding';
import { OtpField } from './OtpField';

const PASSWORD_STALE_DAYS = 90;

type NavKey = 'logins' | 'cards' | 'notes' | 'favourites' | `cat:${string}`;
type Mode = 'view' | 'add' | 'edit';

function emptyInput(itemType: ItemType): CredentialInput {
  return {
    name: '',
    username: '',
    password: '',
    url: '',
    notes: '',
    itemType,
    favourite: false,
    category: '',
    otpSecret: '',
    passwordUpdatedAt: '',
    cardNumber: '',
    cardExpiry: '',
    cardCvv: '',
    cardHolder: '',
  };
}

function inputFromCredential(c: Credential): CredentialInput {
  return {
    name: c.name,
    username: c.username,
    password: c.password,
    url: c.url,
    notes: c.notes,
    itemType: c.itemType,
    favourite: c.favourite,
    category: c.category,
    otpSecret: c.otpSecret,
    passwordUpdatedAt: c.passwordUpdatedAt,
    cardNumber: c.cardNumber,
    cardExpiry: c.cardExpiry,
    cardCvv: c.cardCvv,
    cardHolder: c.cardHolder,
  };
}

const PALETTE = ['#E26D5A', '#6E9BD6', '#5BBF92', '#EBA64E', '#B99BF0', '#E8905F', '#7FB4A0', '#C98BD0'];
function paletteColor(seed: string): string {
  let h = 0;
  for (const ch of seed) {
    h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  }
  return PALETTE[h % PALETTE.length] ?? PALETTE[0] ?? '#E26D5A';
}
function letterTile(name: string): string {
  return (name.trim()[0] ?? '•').toUpperCase();
}
function passwordAgeDays(iso: string): number | null {
  if (iso === '') {
    return null;
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return null;
  }
  return Math.floor((Date.now() - t) / 86_400_000);
}

interface VaultViewProps {
  /** `reason` is presentation only: 'risk' ⇒ a continuous-auth spike (show the lock notice). */
  onLock: (reason?: LockReason | 'manual') => void;
  session: AuthenticatedSession;
}

// Behavioral enrollment progress (Milestone 6) — counts only, never a raw vector.
function EnrollmentBanner({ enrollment }: { enrollment: EnrollmentStatus }) {
  if (enrollment.status === 'active') {
    return null; // a calm "active" state needs no banner in the redesigned vault
  }
  const pct = Math.min(100, Math.round((enrollment.samplesCollected / enrollment.samplesRequired) * 100));
  return (
    <div
      role="status"
      className="mx-4 mt-3 flex items-center gap-[18px] rounded-lg border border-accent/25 bg-gradient-to-r from-accent/10 to-accent/[0.03] px-[18px] py-3"
    >
      <div className="hidden h-9 w-[110px] flex-none sm:block">
        <WaveBars count={14} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-[#f1c281]">
          Building your typing profile — {enrollment.samplesCollected} of {enrollment.samplesRequired}
        </div>
        <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent-lo to-accent-hi transition-[width] duration-500"
            style={{ width: `${String(pct)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

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

const NAV_ITEMS: { key: NavKey; label: string; icon: typeof KeyIcon }[] = [
  { key: 'logins', label: 'Logins', icon: KeyIcon },
  { key: 'cards', label: 'Credit cards', icon: CreditCardIcon },
  { key: 'notes', label: 'Notes', icon: NoteIcon },
  { key: 'favourites', label: 'Favourites', icon: StarIcon },
];

function Sidebar({
  nav,
  onNav,
  categories,
  onNew,
}: {
  nav: NavKey;
  onNav: (n: NavKey) => void;
  categories: string[];
  onNew: () => void;
}) {
  return (
    <aside className="surface-panel flex w-[224px] flex-none flex-col border-r border-line2">
      <div className="flex h-16 flex-none items-center gap-2.5 px-5">
        <BrandMark size={24} />
        <span className="font-display text-[19px] font-semibold tracking-[-0.01em]">Vault</span>
      </div>
      <nav className="flex flex-col gap-0.5 px-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = nav === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                onNav(item.key);
              }}
              className={cn(
                'flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium transition-colors',
                active ? 'bg-white/[0.06] text-fg' : 'text-muted hover:bg-white/[0.03] hover:text-fg',
              )}
            >
              <Icon size={18} className={active ? 'text-accent-hi' : ''} />
              {item.label}
            </button>
          );
        })}
      </nav>

      {categories.length > 0 && (
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-3">
          <div className="px-3 pb-1.5 text-[11px] font-semibold tracking-[0.07em] text-faint">CATEGORIES</div>
          <div className="flex flex-col gap-0.5">
            {categories.map((cat) => {
              const key: NavKey = `cat:${cat}`;
              const active = nav === key;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    onNav(key);
                  }}
                  className={cn(
                    'flex items-center gap-3 rounded-[10px] px-3 py-2 text-[13px] transition-colors',
                    active ? 'bg-white/[0.06] text-fg' : 'text-muted hover:bg-white/[0.03] hover:text-fg',
                  )}
                >
                  <span className="h-2 w-2 flex-none rounded-full" style={{ background: paletteColor(cat) }} />
                  <span className="truncate">{cat}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className={cn('p-3', categories.length === 0 && 'mt-auto')}>
        <Button className="w-full" onClick={onNew}>
          <PlusIcon size={16} /> New item
        </Button>
      </div>
    </aside>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setDone(true);
            setTimeout(() => {
              setDone(false);
            }, 1200);
          })
          .catch(() => undefined);
      }}
      className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-muted2 hover:bg-white/[0.06] hover:text-fg"
    >
      {done ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
    </button>
  );
}

/** A masked secret with reveal + copy (password, card number, CVV). */
function SecretRow({ label, value }: { label: string; value: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <div className="text-[11.5px] text-muted2">{label}</div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{show ? value : '•'.repeat(Math.min(12, Math.max(8, value.length)))}</span>
        <button
          type="button"
          aria-label={show ? `Hide ${label}` : `Reveal ${label}`}
          onClick={() => {
            setShow((s) => !s);
          }}
          className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-muted2 hover:bg-white/[0.06] hover:text-fg"
        >
          {show ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
        </button>
        <CopyButton value={value} label={`Copy ${label}`} />
      </div>
    </div>
  );
}

/** A plain field with optional copy (username, website). */
function PlainRow({ label, value, copyLabel, href }: { label: string; value: string; copyLabel?: string; href?: string }) {
  if (value === '') {
    return null;
  }
  return (
    <div>
      <div className="text-[11.5px] text-muted2">{label}</div>
      <div className="mt-1 flex items-center gap-1.5">
        {href !== undefined ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm text-fg">
            {value}
            <ExternalLinkIcon size={13} className="flex-none text-muted2" />
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{value}</span>
        )}
        {copyLabel !== undefined && <CopyButton value={value} label={copyLabel} />}
      </div>
    </div>
  );
}

function TypeTag({ type, category }: { type: ItemType; category: string }) {
  const label = category !== '' ? category : type === 'card' ? 'Card' : type === 'note' ? 'Note' : 'Login';
  const color = category !== '' ? paletteColor(category) : '#8c929c';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium"
      style={{ background: `${color}22`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function DetailPane({
  credential,
  onEdit,
  onDelete,
  onToggleFavourite,
}: {
  credential: Credential;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFavourite: () => void;
}) {
  const c = credential;
  const isLogin = c.itemType === 'login';
  const isCard = c.itemType === 'card';
  const isNote = c.itemType === 'note';
  const ageDays = passwordAgeDays(c.passwordUpdatedAt);
  const stale = (isLogin || isCard) && ageDays !== null && ageDays >= PASSWORD_STALE_DAYS;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-7">
      <div className="mx-auto max-w-[620px]">
        {/* HEADER */}
        <div className="flex items-start gap-3.5">
          <span
            className="flex h-[52px] w-[52px] flex-none items-center justify-center rounded-[14px] font-display text-base font-bold text-white"
            style={{ background: paletteColor(c.name) }}
          >
            {letterTile(c.name)}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="truncate font-display text-[22px] font-semibold tracking-[-0.01em]">{c.name || 'Untitled'}</h2>
            <div className="mt-1.5">
              <TypeTag type={c.itemType} category={c.category} />
            </div>
          </div>
          <button
            type="button"
            aria-label={c.favourite ? 'Unfavourite' : 'Favourite'}
            onClick={onToggleFavourite}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-[10px] hover:bg-white/[0.06]',
              c.favourite ? 'text-accent-hi' : 'text-muted2 hover:text-fg',
            )}
          >
            {c.favourite ? <StarFilledIcon size={18} /> : <StarIcon size={18} />}
          </button>
          <button
            type="button"
            aria-label="Edit item"
            onClick={onEdit}
            className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted2 hover:bg-white/[0.06] hover:text-fg"
          >
            <PencilIcon size={17} />
          </button>
          <button
            type="button"
            aria-label="Delete item"
            onClick={onDelete}
            className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted2 hover:bg-white/[0.06] hover:text-danger"
          >
            <TrashIcon size={17} />
          </button>
        </div>

        {/* PASSWORD-AGE REMINDER */}
        {stale && (
          <div className="mt-5 flex items-center gap-3 rounded-xl border border-accent/25 bg-accent/[0.08] px-4 py-3">
            <AlertIcon size={18} className="flex-none text-accent-hi" />
            <span className="flex-1 text-[13px] font-medium text-[#f1c281]">It&rsquo;s time to update your password.</span>
            <Button size="sm" onClick={onEdit}>
              Update now
            </Button>
          </div>
        )}

        {/* FIELDS */}
        <div className="mt-6 flex flex-col gap-5 rounded-xl border border-line bg-white/[0.015] p-5">
          {isLogin && (
            <>
              <PlainRow label="Website" value={c.url} copyLabel="Copy website" href={c.url} />
              <PlainRow label="Username" value={c.username} copyLabel="Copy username" />
              <SecretRow label="Password" value={c.password} />
              {isValidOtpSecret(c.otpSecret) && <OtpField secret={c.otpSecret} />}
            </>
          )}
          {isCard && (
            <>
              <PlainRow label="Cardholder" value={c.cardHolder} copyLabel="Copy cardholder" />
              <SecretRow label="Card number" value={c.cardNumber} />
              <div className="flex gap-8">
                <PlainRow label="Expiry" value={c.cardExpiry} />
                {c.cardCvv !== '' && <SecretRow label="CVV" value={c.cardCvv} />}
              </div>
            </>
          )}
          {isNote && c.notes === '' && <div className="text-sm text-faint">This note is empty.</div>}
          {(isLogin || isCard) && c.notes !== '' && (
            <div>
              <div className="text-[11.5px] text-muted2">Notes</div>
              <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted">{c.notes}</div>
            </div>
          )}
          {isNote && c.notes !== '' && (
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{c.notes}</div>
          )}
        </div>
      </div>
    </div>
  );
}

const TYPE_CHOICES: { type: ItemType; label: string }[] = [
  { type: 'login', label: 'Login' },
  { type: 'card', label: 'Card' },
  { type: 'note', label: 'Note' },
];

function ItemForm({
  form,
  mode,
  onPatch,
  onSubmit,
  onCancel,
}: {
  form: CredentialInput;
  mode: 'add' | 'edit';
  onPatch: <K extends keyof CredentialInput>(key: K, value: CredentialInput[K]) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const [showPw, setShowPw] = useState(false);
  const otpInvalid = form.otpSecret !== '' && !isValidOtpSecret(form.otpSecret);
  const isLogin = form.itemType === 'login';
  const isCard = form.itemType === 'card';
  const isNote = form.itemType === 'note';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-7">
      <div className="mx-auto max-w-[560px]">
        <h2 className="font-display text-[20px] font-semibold tracking-[-0.01em]">
          {mode === 'add' ? 'New item' : 'Edit item'}
        </h2>

        {mode === 'add' && (
          <div className="mt-4 flex gap-2">
            {TYPE_CHOICES.map((choice) => (
              <button
                key={choice.type}
                type="button"
                onClick={() => {
                  onPatch('itemType', choice.type);
                }}
                className={cn(
                  'flex-1 rounded-[10px] border px-3 py-2 text-[13px] font-medium transition-colors',
                  form.itemType === choice.type
                    ? 'border-accent/40 bg-accent/[0.10] text-accent-hi'
                    : 'border-line text-muted hover:border-line2 hover:text-fg',
                )}
              >
                {choice.label}
              </button>
            ))}
          </div>
        )}

        <form
          className="mt-5 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Field label="Name">
            <Input
              aria-label="Name"
              placeholder={isCard ? 'e.g. Personal Visa' : isNote ? 'e.g. Recovery codes' : 'e.g. GitHub'}
              value={form.name}
              onChange={(e) => {
                onPatch('name', e.target.value);
              }}
            />
          </Field>

          {isLogin && (
            <>
              <Field label="Username">
                <Input
                  aria-label="Username"
                  placeholder="you@example.com"
                  value={form.username}
                  onChange={(e) => {
                    onPatch('username', e.target.value);
                  }}
                />
              </Field>
              <Field label="Password">
                <div className="relative">
                  <Input
                    aria-label="Password"
                    placeholder="••••••••••••"
                    type={showPw ? 'text' : 'password'}
                    className="pr-11 font-mono"
                    value={form.password}
                    onChange={(e) => {
                      onPatch('password', e.target.value);
                    }}
                  />
                  <button
                    type="button"
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    onClick={() => {
                      setShowPw((s) => !s);
                    }}
                    className="absolute right-1.5 top-1.5 flex h-[34px] w-[34px] items-center justify-center rounded-lg text-muted2 hover:text-fg"
                  >
                    {showPw ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
                  </button>
                </div>
              </Field>
              <Field label="URL">
                <Input
                  aria-label="URL"
                  placeholder="https://…"
                  value={form.url}
                  onChange={(e) => {
                    onPatch('url', e.target.value);
                  }}
                />
              </Field>
              <Field label="One-time password seed (optional)">
                <Input
                  aria-label="One-time password seed"
                  placeholder="Base32 setup key — Cerberus generates the codes"
                  className={cn('font-mono', otpInvalid && 'border-danger/50')}
                  value={form.otpSecret}
                  onChange={(e) => {
                    onPatch('otpSecret', e.target.value);
                  }}
                />
              </Field>
            </>
          )}

          {isCard && (
            <>
              <Field label="Cardholder">
                <Input
                  aria-label="Cardholder"
                  placeholder="Name on card"
                  value={form.cardHolder}
                  onChange={(e) => {
                    onPatch('cardHolder', e.target.value);
                  }}
                />
              </Field>
              <Field label="Card number">
                <Input
                  aria-label="Card number"
                  placeholder="•••• •••• •••• ••••"
                  className="font-mono"
                  value={form.cardNumber}
                  onChange={(e) => {
                    onPatch('cardNumber', e.target.value);
                  }}
                />
              </Field>
              <div className="flex gap-4">
                <Field label="Expiry">
                  <Input
                    aria-label="Expiry"
                    placeholder="MM/YY"
                    className="font-mono"
                    value={form.cardExpiry}
                    onChange={(e) => {
                      onPatch('cardExpiry', e.target.value);
                    }}
                  />
                </Field>
                <Field label="CVV">
                  <Input
                    aria-label="CVV"
                    placeholder="•••"
                    className="font-mono"
                    value={form.cardCvv}
                    onChange={(e) => {
                      onPatch('cardCvv', e.target.value);
                    }}
                  />
                </Field>
              </div>
            </>
          )}

          <Field label="Category (optional)">
            <Input
              aria-label="Category"
              placeholder="e.g. Streaming, Work tools"
              value={form.category}
              onChange={(e) => {
                onPatch('category', e.target.value);
              }}
            />
          </Field>

          <label className="block">
            <span className="block text-xs font-medium text-muted">{isNote ? 'Note' : 'Notes'}</span>
            <textarea
              aria-label="Notes"
              placeholder={isNote ? 'Write your secure note…' : 'Anything else to remember…'}
              rows={isNote ? 6 : 3}
              className="mt-[7px] w-full resize-none rounded-[11px] border border-white/10 bg-field px-[14px] py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
              value={form.notes}
              onChange={(e) => {
                onPatch('notes', e.target.value);
              }}
            />
          </label>

          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" size="sm" disabled={form.name.length === 0 || otpInvalid}>
              {mode === 'add' ? 'Add item' : 'Save changes'}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            {otpInvalid && <span className="text-[12px] text-danger">That doesn&rsquo;t look like a valid setup key.</span>}
          </div>
        </form>
      </div>
    </div>
  );
}

export function VaultView({ onLock, session }: VaultViewProps) {
  const [items, setItems] = useState<CredentialSummary[]>([]);
  const [search, setSearch] = useState('');
  const [nav, setNav] = useState<NavKey>('logins');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Credential | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [form, setForm] = useState<CredentialInput>(emptyInput('login'));
  const [error, setError] = useState<string | null>(null);
  const [totpConfirmed, setTotpConfirmed] = useState<boolean | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  // Set once the onboarding wizard (2FA + typing rhythm) has been completed this session.
  const [onboardingDone, setOnboardingDone] = useState(false);

  // THE single source of truth for the vault's lock state (encryption key in memory).
  const vaultUnlocked = session.vaultUnlocked;
  const token = session.token;

  const refresh = (): void => {
    if (!vaultUnlocked) {
      return;
    }
    void listCredentials()
      .then(setItems)
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };
  useEffect(refresh, [vaultUnlocked]);

  // Every logged-in user MUST have a second factor (mandatory onboarding gates the vault).
  useEffect(() => {
    if (token === null) {
      setTotpConfirmed(null);
      return;
    }
    void getTotpStatus(token)
      .then((s) => {
        setTotpConfirmed(s.confirmed);
      })
      .catch(() => {
        setTotpConfirmed(null);
      });
  }, [token]);

  // Continuous authentication (ADR-0013): stream mouse-dynamics while unlocked; a
  // server-commanded lock (risk spike) zeroizes the keys and returns to the unlock screen.
  useEffect(() => {
    if (token === null || !vaultUnlocked) {
      return;
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

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.category !== '') {
        set.add(item.category);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      const navOk =
        nav === 'logins'
          ? item.itemType === 'login'
          : nav === 'cards'
            ? item.itemType === 'card'
            : nav === 'notes'
              ? item.itemType === 'note'
              : nav === 'favourites'
                ? item.favourite
                : item.category === nav.slice(4);
      if (!navOk) {
        return false;
      }
      if (q === '') {
        return true;
      }
      return (
        item.name.toLowerCase().includes(q) ||
        item.username.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [items, nav, search]);

  const select = (id: string): void => {
    setError(null);
    setMode('view');
    setSelectedId(id);
    void getCredential(id)
      .then(setRevealed)
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const startNew = (): void => {
    setError(null);
    const type: ItemType = nav === 'cards' ? 'card' : nav === 'notes' ? 'note' : 'login';
    setForm(emptyInput(type));
    setRevealed(null);
    setSelectedId(null);
    setMode('add');
  };

  const startEdit = (): void => {
    if (revealed === null) {
      return;
    }
    setForm(inputFromCredential(revealed));
    setMode('edit');
  };

  const patch = <K extends keyof CredentialInput>(key: K, value: CredentialInput[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const save = (): void => {
    setError(null);
    // Stamp the password's last-changed time when it is newly set or actually changed.
    const passwordChanged = revealed === null || revealed.password !== form.password;
    const stampable = form.itemType === 'login' || form.itemType === 'card';
    const toSave: CredentialInput = {
      ...form,
      passwordUpdatedAt:
        stampable && passwordChanged ? new Date().toISOString() : form.passwordUpdatedAt,
    };
    const action =
      mode === 'edit' && selectedId !== null
        ? updateCredential(selectedId, toSave).then(() => selectedId)
        : addCredential(toSave);
    void action
      .then((id) => {
        refresh();
        setMode('view');
        select(id);
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const remove = (): void => {
    if (selectedId === null) {
      return;
    }
    const id = selectedId;
    setError(null);
    void deleteCredential(id)
      .then(() => {
        setSelectedId(null);
        setRevealed(null);
        setMode('view');
        refresh();
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
      });
  };

  const toggleFavourite = (): void => {
    if (revealed === null || selectedId === null) {
      return;
    }
    const next = inputFromCredential(revealed);
    next.favourite = !next.favourite;
    void updateCredential(selectedId, next)
      .then(() => {
        setRevealed({ ...revealed, favourite: next.favourite });
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

  // GUIDED ONBOARDING: before the vault opens, a logged-in user sets up a second factor
  // AND builds their typing-rhythm baseline. The wizard runs whichever steps are still
  // needed (2FA is mandatory; the rhythm step is skippable — it keeps learning on sign-in)
  // and calls onComplete → the vault. Gated until the 2FA status has resolved so we never
  // flash the wrong step. The continuous-auth lock effect above keeps running throughout.
  const needsTotp = totpConfirmed === false;
  const needsRhythm = session.enrollment !== null && session.enrollment.status !== 'active';
  if (token !== null && totpConfirmed !== null && !onboardingDone && (needsTotp || needsRhythm)) {
    return (
      <Onboarding
        token={token}
        needsTotp={needsTotp}
        initialEnrollment={session.enrollment}
        onComplete={() => {
          setOnboardingDone(true);
        }}
        onSignOut={() => {
          onLock('manual');
        }}
      />
    );
  }

  // The Risk & Behavior Inspector is a dedicated full-screen view (not an overlay):
  // VaultView stays mounted so the continuous-auth lock keeps running while inspecting.
  if (showDashboard && token !== null) {
    return (
      <RiskDashboard
        token={token}
        onClose={() => {
          setShowDashboard(false);
        }}
      />
    );
  }

  if (!vaultUnlocked) {
    return (
      <div className="surface-card flex min-h-0 w-full flex-1 flex-col overflow-hidden animate-fadeUp">
        <header className="flex h-16 flex-none items-center gap-2.5 border-b border-line2 px-[22px]">
          <BrandMark size={26} />
          <span className="font-display text-xl font-semibold tracking-[-0.01em]">Vault</span>
        </header>
        <LockedVault
          onReturn={() => {
            onLock('manual');
          }}
        />
      </div>
    );
  }

  const navTitle =
    nav === 'logins'
      ? 'Logins'
      : nav === 'cards'
        ? 'Credit cards'
        : nav === 'notes'
          ? 'Notes'
          : nav === 'favourites'
            ? 'Favourites'
            : nav.slice(4);

  return (
    <div className="surface-card flex min-h-0 w-full flex-1 overflow-hidden animate-fadeUp">
      <Sidebar nav={nav} onNav={setNav} categories={categories} onNew={startNew} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* TOP BAR */}
        <header className="flex h-16 flex-none items-center gap-3 border-b border-line2 px-5">
          <div className="relative max-w-[440px] flex-1">
            <SearchIcon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted2" />
            <input
              aria-label="Search vault"
              placeholder="Search vault…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              className="h-10 w-full rounded-[11px] border border-line2 bg-field pl-9 pr-3 text-[13.5px] text-fg outline-none placeholder:text-faint focus:border-accent"
            />
          </div>
          <div className="flex-1" />
          <span className="flex items-center gap-[6px] rounded-full border border-ok/25 bg-ok/[0.08] py-[5px] pl-[9px] pr-[11px]">
            <span className="h-[7px] w-[7px] animate-glow rounded-full bg-ok shadow-[0_0_8px_#5bbf92]" />
            <span className="text-[11.5px] font-medium text-ok">Protected</span>
          </span>
          {token !== null && (
            <button
              type="button"
              aria-label="Risk inspector"
              title="Risk &amp; Behavior Inspector (research)"
              onClick={() => {
                setShowDashboard(true);
              }}
              className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted2 hover:bg-white/[0.06] hover:text-fg"
            >
              <ShieldCheckIcon size={18} />
            </button>
          )}
          <button
            type="button"
            aria-label="Lock vault"
            title="Lock vault"
            onClick={doLock}
            className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted2 hover:bg-white/[0.06] hover:text-fg"
          >
            <LockIcon size={18} />
          </button>
          <button
            type="button"
            aria-label="Help"
            title="Help"
            className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted2 hover:bg-white/[0.06] hover:text-fg"
          >
            <HelpIcon size={18} />
          </button>
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent/[0.18] text-[12px] font-semibold text-accent-hi">
            <ShieldCheckIcon size={16} />
          </span>
        </header>

        {session.enrollment !== null && <EnrollmentBanner enrollment={session.enrollment} />}
        {error !== null && (
          <div className="px-4 pt-3">
            <Banner tone="error" title={error} />
          </div>
        )}

        {/* LIST + DETAIL */}
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[330px] flex-none flex-col border-r border-line2">
            <div className="flex items-center justify-between px-5 pb-1.5 pt-4">
              <span className="text-[11px] font-semibold tracking-[0.06em] text-faint">
                {navTitle.toUpperCase()} ({filtered.length})
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
              {filtered.length === 0 ? (
                <div className="px-5 py-16 text-center">
                  <div className="text-[13.5px] font-semibold text-muted">Nothing here yet</div>
                  <div className="mt-1 text-[12.5px] text-faint">
                    {search !== '' ? 'No items match your search.' : 'Create one with “New item”.'}
                  </div>
                </div>
              ) : (
                filtered.map((item) => {
                  const active = selectedId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        select(item.id);
                      }}
                      className={cn(
                        'mb-0.5 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                        active
                          ? 'border-accent/30 bg-accent/[0.06]'
                          : 'border-transparent hover:border-line hover:bg-white/[0.03]',
                      )}
                    >
                      <span
                        className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[10px] font-display text-[13px] font-bold text-white"
                        style={{ background: paletteColor(item.name) }}
                      >
                        {letterTile(item.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-semibold text-fg">{item.name || 'Untitled'}</span>
                        <span className="block truncate text-[12px] text-muted2">
                          {item.username !== '' ? item.username : item.url !== '' ? item.url : item.category}
                        </span>
                      </span>
                      {item.favourite && <StarFilledIcon size={13} className="flex-none text-accent-hi" />}
                      {item.hasOtp && <KeyIcon size={14} className="flex-none text-muted2" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {mode === 'add' || mode === 'edit' ? (
            <ItemForm
              form={form}
              mode={mode}
              onPatch={patch}
              onSubmit={save}
              onCancel={() => {
                setMode('view');
                if (selectedId === null) {
                  setRevealed(null);
                }
              }}
            />
          ) : revealed !== null ? (
            <DetailPane
              credential={revealed}
              onEdit={startEdit}
              onDelete={remove}
              onToggleFavourite={toggleFavourite}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
              <div className="flex h-[58px] w-[58px] items-center justify-center rounded-2xl border border-line2 bg-white/[0.04] text-muted2">
                <KeyIcon size={26} />
              </div>
              <h2 className="mt-5 font-display text-lg font-semibold tracking-[-0.01em]">Select an item</h2>
              <p className="mt-1.5 max-w-[320px] text-[13px] leading-[1.55] text-muted">
                Pick an item from the list to see its details, or create a new one.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
