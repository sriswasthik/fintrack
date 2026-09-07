import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { healthRouter } from './routes/health';

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
  app.use(express.json());

  app.use('/api', healthRouter);

  return app;
}

export const app = createApp();
