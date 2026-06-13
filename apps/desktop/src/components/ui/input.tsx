// Input primitive (shadcn/ui pattern). It is a PLAIN <input> with a forwarded ref
// — no debounce, no segmentation, no key interception — so the M6 keystroke-timing
// capture (lib/keystroke) attaches to the real DOM node exactly as before
// (PROJECT.md §4.2 / M12 keystroke-capture constraint). Presentation only.
import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'w-full h-[46px] px-[14px] rounded-[11px] bg-field border border-white/10 text-fg text-sm',
      'placeholder:text-faint outline-none transition-[border-color,box-shadow]',
      'focus:border-accent focus-visible:outline-none',
      'disabled:opacity-60 disabled:cursor-not-allowed',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
