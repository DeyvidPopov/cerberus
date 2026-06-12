import type { Request, Response } from 'express';

// Terminal handler for unmatched routes. Returns a stable, non-leaking shape.
export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found' });
}
