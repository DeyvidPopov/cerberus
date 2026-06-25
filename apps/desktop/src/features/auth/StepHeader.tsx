// Shared header for the onboarding wizard steps: a "Step n of N" badge + progress pips,
// then the step title and a one-line "what / why" subtitle. Presentation only.
import { cn } from '../../lib/cn';

export interface StepInfo {
  n: number;
  total: number;
}

export function StepHeader({ step, title, subtitle }: { step: StepInfo; title: string; subtitle: string }) {
  return (
    <div>
      {step.total > 1 && (
        <div className="flex items-center gap-2.5">
          <span className="rounded-full border border-accent/30 bg-accent/[0.10] px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-accent-hi">
            Step {step.n} of {step.total}
          </span>
          <div className="flex gap-1">
            {Array.from({ length: step.total }).map((_v, i) => (
              <span key={i} className={cn('h-[3px] w-5 rounded-full', i < step.n ? 'bg-accent' : 'bg-white/[0.1]')} />
            ))}
          </div>
        </div>
      )}
      <h1 className={cn('font-display text-[25px] font-semibold tracking-[-0.02em]', step.total > 1 && 'mt-3.5')}>
        {title}
      </h1>
      <p className="mt-[7px] text-[13.5px] leading-[1.5] text-muted">{subtitle}</p>
    </div>
  );
}
