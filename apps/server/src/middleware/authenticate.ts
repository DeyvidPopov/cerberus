import type { NextFunction, Request, Response } from 'express';

import type { SessionsRepository } from '../repositories/sessions';
import { hashSessionToken } from '../services/auth-crypto';

const BEARER_PREFIX = 'Bearer ';

// Session-auth middleware (the `auth` slot in the §4.3 chain). Verifies the
// Bearer token by hashing it and looking up an active session; attaches the
// non-secret identity to res.locals.session. Any failure → 401 (fail closed).
export function createAuthenticate(sessions: SessionsRepository) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void verify(sessions, req, res, next).catch(next);
  };
}

async function verify(
  sessions: SessionsRepository,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization');
  const token =
    header !== undefined && header.startsWith(BEARER_PREFIX)
      ? header.slice(BEARER_PREFIX.length)
      : undefined;

  if (token === undefined || token.length === 0) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const session = await sessions.findActiveByTokenHash(hashSessionToken(token));
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  res.locals.session = { userId: session.userId, deviceId: session.deviceId };
  next();
}
