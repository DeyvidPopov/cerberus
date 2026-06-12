import type { NextFunction, Request, Response } from 'express';

// Centralised error handler (last in the chain). Express identifies an error
// handler by its four-parameter arity, so all four are kept even when unused.
// Error responses never leak internal detail or secret material
// (PROJECT.md §4.1, §5).
export function errorHandler(
  _err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId =
    typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  // TODO (later phases): structured logging — IDs and decisions only, never PII
  // or secrets (PROJECT.md §5).
  res.status(500).json({ error: 'internal_error', requestId });
}
