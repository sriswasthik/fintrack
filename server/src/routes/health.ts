import { Router } from 'express';

export const healthRouter = Router();

/**
 * GET /api/health — liveness probe used by the client (and later by the
 * deployment platform) to confirm the API is reachable.
 */
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
