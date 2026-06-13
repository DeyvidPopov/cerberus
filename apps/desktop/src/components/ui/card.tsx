// Card / surface shell primitive (shadcn/ui pattern). Presentation only.
import { forwardRef, type HTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('surface-card rounded-2xl border border-line shadow-card overflow-hidden', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';
