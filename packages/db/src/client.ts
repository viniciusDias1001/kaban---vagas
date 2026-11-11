import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

// API, worker e scripts rodam com cwds diferentes: todos leem o mesmo <raiz do repo>/.env.
// Variáveis já definidas no ambiente têm precedência (loadEnvFile não sobrescreve).
try {
  const envFile = resolve(REPO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
} catch {
  // .env ilegível ou malformado: segue só com o ambiente do processo.
}

/**
 * Tipo aceito por todo o código da aplicação. Tanto a instância postgres-js (produção) quanto a
 * PGlite (testes) são atribuíveis a ele.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export function createDb(url: string | undefined = process.env.DATABASE_URL) {
  if (!url) {
    throw new Error(
      'DATABASE_URL não definida. Copie .env.example para .env e ajuste a URL do Postgres ' +
        '(local: `docker compose up -d`; produção: connection string do Supabase).',
    );
  }
  // prepare: false — compatível com o pooler em modo transação do Supabase (porta 6543).
  const client = postgres(url, { prepare: false, max: 5, onnotice: () => {} });
  return drizzle(client, { schema });
}

interface Closable {
  end?: (opts?: { timeout?: number }) => Promise<void>;
  close?: () => Promise<void>;
}

/** Fecha as conexões de um Db criado por `createDb` (ou por `createTestDb`). */
export async function closeDb(db: Db): Promise<void> {
  const client = (db as { $client?: Closable }).$client;
  if (typeof client?.end === 'function') await client.end({ timeout: 5 });
  else if (typeof client?.close === 'function') await client.close();
}

interface ErrorLike {
  message?: string;
  code?: string;
  errors?: ErrorLike[];
  cause?: unknown;
}

/**
 * Mensagem legível de um erro de banco: o Drizzle embrulha o erro do driver em `cause` ("Failed query: ..."),
 * e erros de conexão do Node vêm como AggregateError sem message (só `code`/`errors`).
 */
export function dbErrorMessage(e: unknown): string {
  const outer = e as ErrorLike | undefined;
  const root = (outer?.cause ?? outer) as ErrorLike | undefined;
  return root?.message || root?.errors?.[0]?.message || root?.code || outer?.message || String(e);
}

const TABLES = ['search_profiles', 'jobs', 'job_events', 'runs'];

/**
 * Falha com uma mensagem clara se o banco está inacessível ou sem as tabelas.
 * API e worker chamam isto ao subir; nenhum dos dois roda migrations (evita corrida entre eles).
 */
export async function assertDbReady(db: Db): Promise<void> {
  let found: string[];
  try {
    const result = (await db.execute(
      sql`select table_name from information_schema.tables where table_schema = current_schema()`,
    )) as unknown as { table_name: string }[] | { rows?: { table_name: string }[] };
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    found = rows.map((r) => r.table_name);
  } catch (e) {
    throw new Error(
      `Não foi possível conectar ao Postgres (${dbErrorMessage(e)}). Confira DATABASE_URL no .env e se o banco ` +
        'está no ar (local: `docker compose up -d`).',
      { cause: e },
    );
  }
  const missing = TABLES.filter((t) => !found.includes(t));
  if (missing.length > 0) {
    throw new Error(`Banco sem as tabelas ${missing.join(', ')}: rode pnpm db:migrate.`);
  }
}
