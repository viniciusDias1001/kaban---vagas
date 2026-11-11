import { openDb } from '@kv/db';
import { buildApp } from './app';

const port = Number(process.env.API_PORT ?? 3333);
const app = buildApp(openDb());

app.listen({ port, host: '127.0.0.1' }).then(
  () => console.log(`[api] http://127.0.0.1:${port}`),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
