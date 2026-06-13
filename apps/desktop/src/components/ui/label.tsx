// Label primitive + Field wrapper (shadcn/ui pattern). Presentation only.
import { forwardRef, type LabelHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../../lib/cn';

export const Label = forwardRef<HTMLSpanElement, LabelHTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span ref={ref} className={cn('block text-xs font-medium text-muted', className)} {...props} />
  ),
);
Label.displayName = 'Label';

/** A labelled control: <label> wrapping the label text + its input (design pattern). */
export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <Label>{label}</Label>
      <div className="mt-[7px]">{children}</div>
    </label>
  );
}
