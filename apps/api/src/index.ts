import { assertDbReady, createDb } from '@kv/db';
import { buildApp } from './app';

const port = Number(process.env.API_PORT ?? 3333);

try {
  // A API não roda migrations (isso é do `pnpm db:migrate`); só confere que o banco está pronto.
  const db = createDb();
  await assertDbReady(db);
  await buildApp(db).listen({ port, host: '127.0.0.1' });
  console.log(`[api] http://127.0.0.1:${port}`);
} catch (err) {
  console.error(`[api] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
