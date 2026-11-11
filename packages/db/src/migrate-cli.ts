import { closeDb, createDb, dbErrorMessage } from './client';
import { migrate } from './migrate';

try {
  const db = createDb();
  try {
    await migrate(db);
    console.log('[db] migrations aplicadas');
  } finally {
    await closeDb(db);
  }
} catch (e) {
  console.error(`[db] falha ao migrar: ${dbErrorMessage(e)}`);
  process.exit(1);
}
