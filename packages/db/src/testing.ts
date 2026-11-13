import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from './client';
import { MIGRATIONS_FOLDER } from './migrate';
import * as schema from './schema';

/**
 * Postgres em memória (PGlite) com as mesmas migrations commitadas — para testes, sem serviço externo.
 * Fica fora do `index.ts` para o PGlite não ser carregado em produção. Feche com `closeDb(db)`.
 */
export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

/** Esvazia todas as tabelas e reinicia os ids — bem mais rápido que criar um banco por teste. */
export async function resetTestDb(db: Db): Promise<void> {
  await db.execute(sql`truncate table search_profiles, jobs, job_events, runs, resumes, profiles, job_ai, tailored_resumes, ai_tasks, ai_usage,
        settings, ai_keys, applications, application_events, apply_answers, apply_commands, apply_sites
        restart identity cascade`);
}
