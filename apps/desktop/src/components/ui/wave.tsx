// Typing-rhythm wave bars — the design's signature motif for the behavioral layer
// (brand panel + enrollment). Purely decorative animation; conveys "learning your
// typing rhythm" without implying any specific captured data. Presentation only.
import { cn } from '../../lib/cn';

interface WaveBarsProps {
  count?: number;
  className?: string;
  barClassName?: string;
  /** When false, bars render static (no animation) — used for reduced-motion / static contexts. */
  animate?: boolean;
}

// Deterministic per-bar delay/height so the wave looks organic without randomness.
const DELAYS = [0, 0.18, 0.36, 0.1, 0.46, 0.26, 0.05, 0.4, 0.22, 0.32, 0.14, 0.5];

export function WaveBars({ count = 9, className, barClassName, animate = true }: WaveBarsProps) {
  return (
    <div className={cn('flex items-end gap-[3px] h-10', className)} aria-hidden="true">
      {Array.from({ length: count }, (_v, i) => (
        <span
          key={i}
          className={cn('w-[3px] flex-1 rounded-full bg-accent/70', animate && 'wave-bar', barClassName)}
          style={{ height: '100%', animationDelay: `${String(DELAYS[i % DELAYS.length])}s` }}
        />
      ))}
    </div>
  );
}
