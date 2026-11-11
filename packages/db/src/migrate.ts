import { fileURLToPath } from 'node:url';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client';

/** Pasta com o SQL versionado (gerado por `pnpm db:generate`). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Aplica as migrations pendentes; idempotente (o Drizzle registra as aplicadas em
 * `drizzle.__drizzle_migrations`). Rodado por `pnpm db:migrate` — nunca no start da API ou do worker.
 */
export async function migrate(db: Db): Promise<void> {
  // O migrator só usa `dialect` e `session`, comuns a qualquer PgDatabase.
  await drizzleMigrate(db as unknown as PostgresJsDatabase<Record<string, unknown>>, {
    migrationsFolder: MIGRATIONS_FOLDER,
  });
}
