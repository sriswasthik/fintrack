// Load server/.env before anything reads process.env. In a deployed
// environment the platform supplies these directly and there is no .env file,
// which dotenv treats as a no-op.
import 'dotenv/config';

import { app } from './app';

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`FinTrack API listening on http://localhost:${port}`);
});
