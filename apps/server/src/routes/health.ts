import { Router } from 'express';

import { getHealth } from '../services/health';

// Thin HTTP surface (PROJECT.md §4.3): the route delegates to the service and
// performs no business logic and no DB access.
export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json(getHealth());
});
