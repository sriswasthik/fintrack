import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { authConfigurationHandler, requireAuth, requireWritableSession } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { accountsRouter } from './routes/accounts';
import { authRouter } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { healthRouter } from './routes/health';
import { insightsRouter } from './routes/insights';
import { summaryRouter } from './routes/summary';
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
      // Locked to the client origin rather than reflecting whatever asked.
      // `credentials` is what lets the refresh cookie cross from :5173 to :4000
      // in development, and a wildcard origin is not allowed alongside it —
      // which is the rule that makes an origin allowlist mandatory here.
      origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
      credentials: true,
    }),
  );
  // A committed import is one large JSON body; the default 100kb is far too small.
  app.use(express.json({ limit: '25mb' }));
  // The refresh token arrives as a cookie the client cannot read itself.
  app.use(cookieParser());

  // Public: liveness, and the routes a person uses before they have a session.
  app.use('/api', healthRouter);
  app.use('/api', authRouter);

  // Everything below carries data belonging to somebody. `requireAuth` is
  // mounted here, once, rather than per route, so a new route is protected by
  // default and forgetting to add it is not a way to leak an account.
  // `requireWritableSession` rides alongside it for the same reason: a demo
  // session is read-only everywhere, including on a route added tomorrow.
  const session = [requireAuth, requireWritableSession];

  app.use('/api', session, accountsRouter);
  app.use('/api', session, dashboardRouter);
  app.use('/api', session, insightsRouter);
  app.use('/api', session, summaryRouter);
  app.use('/api', session, transactionsRouter);

  app.use(notFoundHandler);
  app.use(authConfigurationHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
