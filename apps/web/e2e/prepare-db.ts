/**
 * Prepara o banco do e2e: cria se não existir, aplica as migrations e esvazia as tabelas, para cada
 * execução começar limpa. Também esvazia a pasta de dados da candidatura do e2e (`E2E_APPLY_DATA_DIR`).
 *
 * Roda encadeado no comando do `webServer` do Playwright (antes do `pnpm dev`), e não como
 * `globalSetup`: o Playwright sobe o webServer ANTES do globalSetup, e a API não inicia sem as tabelas.
 */
import { closeDb, createDb, dbErrorMessage, migrate } from '../../../packages/db/src/index';
import { resetApplyDataDir } from './apply-data';
import { E2E_DATABASE_URL, e2eDatabaseName } from './database';

const TABLES = [
  'job_events', 'jobs', 'runs', 'search_profiles', 'resumes', 'profiles', 'job_ai', 'tailored_resumes', 'ai_tasks', 'ai_usage',
  'settings', 'ai_keys', 'applications', 'application_events', 'apply_answers', 'apply_commands', 'apply_sites',
];

async function createDatabaseIfMissing(url: string, name: string): Promise<void> {
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = createDb(adminUrl.href);
  try {
    const found = (await admin.execute(`select 1 from pg_database where datname = '${name}'`)) as unknown as unknown[];
    if (found.length === 0) {
      // `name` já passou pela validação de e2eDatabaseName (só letras, dígitos e _).
      await admin.execute(`create database "${name}"`);
      console.log(`[e2e] banco ${name} criado`);
    }
  } finally {
    await closeDb(admin);
  }
}

try {
  const name = e2eDatabaseName(E2E_DATABASE_URL);
  await createDatabaseIfMissing(E2E_DATABASE_URL, name);
  const db = createDb(E2E_DATABASE_URL);
  try {
    await migrate(db);
    await db.execute(`truncate table ${TABLES.join(', ')} restart identity cascade`);
  } finally {
    await closeDb(db);
  }
  console.log(`[e2e] banco ${name} migrado e esvaziado`);
  // A pasta de dados da candidatura (perfil do navegador, currículos, fotos) também começa vazia.
  resetApplyDataDir();
} catch (e) {
  console.error(`[e2e] falha ao preparar o banco: ${dbErrorMessage(e)}`);
  process.exit(1);
}
