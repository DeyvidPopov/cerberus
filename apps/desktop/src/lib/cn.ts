// shadcn/ui className helper: merge conditional classes, de-duplicating
// conflicting Tailwind utilities (the last wins). Used by every ui/ primitive.
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
