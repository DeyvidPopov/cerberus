// Button primitive (shadcn/ui pattern: cva variants + cn). Presentation only.
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[11px] font-medium ' +
    'transition-[filter,background,opacity,border-color] disabled:opacity-50 disabled:pointer-events-none ' +
    'focus-visible:outline-none',
  {
    variants: {
      variant: {
        primary:
          'fill-accent text-accent-fg font-semibold shadow-accent hover:brightness-105 active:brightness-95',
        secondary:
          'bg-white/[0.06] border border-line text-fg hover:bg-white/[0.1]',
        ghost: 'text-muted hover:text-fg hover:bg-white/[0.05]',
        link: 'text-accent-hi font-medium hover:underline px-0 h-auto',
        icon: 'text-muted2 border border-line hover:text-fg hover:bg-white/[0.05]',
      },
      size: {
        md: 'h-12 px-4 text-[14.5px]',
        sm: 'h-[42px] px-4 text-[13.5px]',
        icon: 'h-9 w-9 rounded-[10px]',
        chip: 'h-[34px] px-3 text-[12.5px] rounded-[9px]',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

export { buttonVariants };
