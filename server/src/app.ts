import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { authConfigurationHandler, requireAuth, requireWritableSession } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { accountsRouter } from './routes/accounts';
import { authRouter } from './routes/auth';
import { budgetsRouter } from './routes/budgets';
import { dashboardRouter } from './routes/dashboard';
import { healthRouter } from './routes/health';
import { importsRouter } from './routes/imports';
import { indiaRouter } from './routes/india';
import { insightsRouter } from './routes/insights';
import { meRouter } from './routes/me';
import { payeesRouter } from './routes/payees';
import { rulesRouter } from './routes/rules';
import { statementsRouter } from './routes/statements';
import { summaryRouter } from './routes/summary';
import { totalsRouter } from './routes/totals';
import { transactionsRouter } from './routes/transactions';

/**
 * How many proxies in front of this server to believe about the client's
 * address, as Express's `trust proxy` setting.
 *
 * It matters because the rate limiters key a signed-out request by `req.ip`.
 * Render and Railway both put one load balancer in front of the app, so with
 * the setting off every request appears to come from that balancer, and the
 * sign-in budget of one address becomes the budget of everybody at once. Set
 * too high, the opposite goes wrong: a caller could write any address it liked
 * into `X-Forwarded-For` and reset its own budget.
 *
 * `TRUST_PROXY` takes a hop count, `true`/`false`, or anything else Express
 * accepts (`loopback`, a list of subnets). Unset, it is one hop in production —
 * what both documented platforms need — and off everywhere else.
 */
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env): boolean | number | string {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return env.NODE_ENV === 'production' ? 1 : false;

  const lower = raw.toLowerCase();
  if (lower === 'false' || lower === 'off') return false;
  if (lower === 'true' || lower === 'on') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Builds the Express application. Kept separate from `index.ts` so tests can
 * mount it with Supertest without opening a port.
 */
export function createApp() {
  const app = express();

  app.set('trust proxy', trustProxySetting());

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
  app.use('/api', session, budgetsRouter);
  app.use('/api', session, dashboardRouter);
  app.use('/api', session, importsRouter);
  app.use('/api', session, indiaRouter);
  app.use('/api', session, insightsRouter);
  app.use('/api', session, meRouter);
  app.use('/api', session, payeesRouter);
  app.use('/api', session, rulesRouter);
  app.use('/api', session, statementsRouter);
  app.use('/api', session, summaryRouter);
  app.use('/api', session, totalsRouter);
  app.use('/api', session, transactionsRouter);

  app.use(notFoundHandler);
  app.use(authConfigurationHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
