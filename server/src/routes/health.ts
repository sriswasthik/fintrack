import { Router } from 'express';

import { demoModeEnabled } from '../services/auth/demo';

export const healthRouter = Router();

/**
 * GET /api/health — liveness probe used by the client (and by the deployment
 * platform) to confirm the API is reachable.
 *
 * It also reports whether this deployment offers demo mode, which is how the
 * client decides to show a "view the demo" button at all. A private instance
 * with the flag off never advertises one.
 */
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', demo: demoModeEnabled() });
});
