// The auth shell (ADR-0015): a two-panel card — a brand panel telling the
// behavioral-vault story (hidden on narrow widths) + the content panel that holds
// register / unlock / step-up. Presentation only; no logic.
import type { ReactNode } from 'react';

import { BrandMark } from '../../components/icons';
import { WaveBars } from '../../components/ui/wave';

// Generic, non-leaking trust copy — the UI never names a specific risk signal,
// not even as branding (ADR-0012 / ADR-0015 no-risk-detail rule).
const TRUST_TAGS = ['Zero-knowledge', 'Adaptive trust', 'End-to-end encrypted'];

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="surface-card relative flex w-[min(1080px,94vw)] h-[min(720px,90vh)] overflow-hidden rounded-2xl border border-line shadow-card animate-fadeUp">
      {/* BRAND PANEL */}
      <aside className="surface-panel relative hidden w-[44%] min-w-[380px] flex-col justify-between overflow-hidden border-r border-line2 p-[42px] lg:flex">
        <div className="pointer-events-none absolute -right-40 -top-28 h-[420px] w-[420px] rounded-full bg-accent/[0.16] blur-lg" />
        <div className="relative flex items-center gap-3">
          <BrandMark />
          <div>
            <div className="font-display text-[17px] font-semibold tracking-[0.16em]">CERBERUS</div>
            <div className="mt-px text-[11px] tracking-[0.04em] text-[#7a8089]">Behavioral vault</div>
          </div>
        </div>

        <div className="relative">
          <div className="mb-7 w-44">
            <WaveBars count={11} />
          </div>
          <h2 className="max-w-[330px] font-display text-3xl font-semibold leading-[1.18] tracking-[-0.02em]">
            Your vault knows it&rsquo;s you.
          </h2>
          <p className="mt-3.5 max-w-[330px] text-[13.5px] leading-relaxed text-muted">
            Cerberus learns the rhythm of how you type and move — a quiet second layer of trust
            around your credentials.
          </p>
        </div>

        <div className="relative flex flex-wrap gap-2">
          {TRUST_TAGS.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-line bg-white/[0.02] px-[11px] py-[5px] text-[11px] text-[#8c929c]"
            >
              {tag}
            </span>
          ))}
        </div>
      </aside>

      {/* CONTENT PANEL */}
      <section className="relative flex flex-1 items-center justify-center p-10 sm:px-12">
        <div className="w-full max-w-[360px]">{children}</div>
      </section>
    </main>
  );
}
