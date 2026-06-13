// Toned status banner — the design's "ue" outcome panel. Used for login outcomes
// (info vs error), inline validation, and vault errors. A coloured dot + title +
// message. CRITICAL: callers pass only GENERIC copy — this component never derives
// or reveals which risk signal fired (PROJECT.md §1, ADR-0012). Presentation only.
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export type BannerTone = 'error' | 'info' | 'success';

const TONES: Record<BannerTone, { dot: string; title: string; ring: string; bg: string }> = {
  error: { dot: 'bg-danger', title: 'text-danger', ring: 'border-danger/35', bg: 'bg-danger/[0.08]' },
  info: { dot: 'bg-info', title: 'text-info', ring: 'border-info/30', bg: 'bg-info/[0.07]' },
  success: { dot: 'bg-ok', title: 'text-ok', ring: 'border-ok/35', bg: 'bg-ok/[0.08]' },
};

interface BannerProps {
  tone: BannerTone;
  title: string;
  children?: ReactNode;
  /** role: 'alert' for errors (assertive), 'status' for info/success (polite). */
  role?: 'alert' | 'status';
  className?: string;
}

export function Banner({ tone, title, children, role, className }: BannerProps) {
  const t = TONES[tone];
  return (
    <div
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={cn('flex items-start gap-3 rounded-xl border px-[14px] py-[13px]', t.ring, t.bg, className)}
    >
      <span className={cn('mt-[5px] h-[7px] w-[7px] flex-none rounded-full', t.dot)} />
      <div className="min-w-0">
        <div className={cn('text-[13px] font-semibold', t.title)}>{title}</div>
        {children !== undefined && (
          <div className="mt-0.5 text-[12.5px] leading-[1.45] text-muted">{children}</div>
        )}
      </div>
    </div>
  );
}
