import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Wraps an async handler so a rejected promise is forwarded to the Express error
// handler instead of becoming an unhandled rejection (no floating promises, §4.2).
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
