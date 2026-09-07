import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { accountsRouter } from './routes/accounts';
import { healthRouter } from './routes/health';
import { transactionsRouter } from './routes/transactions';

/**
 * Builds the Express application. Kept separate from `index.ts` so tests can
 * mount it with Supertest without opening a port.
 */
export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
      // The refresh token is delivered as an httpOnly cookie (see PROJECT_CONTEXT.md §3).
      credentials: true,
    }),
  );
  // A committed import is one large JSON body; the default 100kb is far too small.
  app.use(express.json({ limit: '25mb' }));

  app.use('/api', healthRouter);
  app.use('/api', accountsRouter);
  app.use('/api', transactionsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
