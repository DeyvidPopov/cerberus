import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

// Runtime boundary validation (PROJECT.md §4.2): every external request body is
// validated with zod before a handler runs. On success the parsed, typed value
// is stored in res.locals.body; on failure a generic 400 is returned (the
// invalid input is never echoed back — it may carry secret-adjacent material).
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    res.locals.body = result.data;
    next();
  };
}
