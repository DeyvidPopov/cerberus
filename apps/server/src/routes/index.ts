import { Router } from 'express';

import { healthRouter } from './health';

// Aggregates route modules. New route groups are mounted here as they land.
export const routes = Router();

routes.use(healthRouter);
