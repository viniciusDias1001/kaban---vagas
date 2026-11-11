import { sql } from 'drizzle-orm';
import { closeDb, createDb, dbErrorMessage, retryUntilReady } from './client';
import { migrate } from './migrate';

// `--wait` (usado pelo start de produção): se o banco ainda não aceita conexões, insiste por até
// ~5 minutos antes de desistir. Sem a flag (`pnpm db:migrate`, `pnpm dev`) a falha é imediata.
const wait = process.argv.includes('--wait');

try {
  const db = createDb();
  try {
    if (wait) {
      await retryUntilReady(async () => void (await db.execute(sql`select 1`)), {
        isFatal: () => false,
        onRetry: ({ attempt, waitMs, error }) =>
          console.error(
            `[db] banco indisponível (tentativa ${attempt}: ${dbErrorMessage(error)}); nova tentativa em ${waitMs / 1000} s`,
          ),
      });
    }
    await migrate(db);
    console.log('[db] migrations aplicadas');
  } finally {
    await closeDb(db);
  }
} catch (e) {
  console.error(`[db] falha ao migrar: ${dbErrorMessage(e)}`);
  process.exit(1);
}
