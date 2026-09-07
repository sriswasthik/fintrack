import { app } from './app';

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`FinTrack API listening on http://localhost:${port}`);
});
