// Load server/.env before anything reads process.env. In a deployed
// environment the platform supplies these directly and there is no .env file,
// which dotenv treats as a no-op.
import 'dotenv/config';

import { app } from './app';
import { configurationWarnings } from './configWarnings';
import { log } from './middleware/requestLog';

// Anything that escapes every handler is logged in the same shape as the rest,
// rather than as whatever Node prints by default. An uncaught exception leaves
// the process in an unknown state, so it exits and the platform restarts it.
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
process.on('uncaughtException', (error) => {
  log('error', 'uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`FinTrack API listening on http://localhost:${port}`);
  for (const warning of configurationWarnings()) log('warn', `[config] ${warning}`);
});
