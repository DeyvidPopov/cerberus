import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

// First middleware in the fixed chain (PROJECT.md §4.3):
//   request-id → auth → rate-limit → validation → handler
// Attaches a stable id to every request for log correlation. Logs carry IDs and
// decisions, never PII or secrets (PROJECT.md §5).
export const REQUEST_ID_HEADER = 'x-request-id';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id = incoming ?? randomUUID();

  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);

  next();
}
