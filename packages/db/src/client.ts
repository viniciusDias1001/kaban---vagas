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
  const ssl = sslFor(url);
  const client = postgres(url, { prepare: false, max: 5, onnotice: () => {}, ...(ssl ? { ssl } : {}) });
  return drizzle(client, { schema });
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

/**
 * O postgres-js só usa TLS quando pedido. Devolve `'require'` quando a conexão deve ser criptografada:
 * host que não é local e URL sem `sslmode`/`ssl` explícito. Devolve undefined (o driver decide) para
 * hosts locais — localhost, 127.0.0.1, ::1, host.docker.internal ou um nome sem ponto, como o de um
 * serviço do Docker (`postgres`) — e sempre que a URL (ou `PGSSLMODE`) já diz o que quer, inclusive
 * `sslmode=disable` para um Postgres em rede privada sem TLS.
 */
export function sslFor(url: string, env: Record<string, string | undefined> = process.env): 'require' | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined; // URL que o WHATWG não entende (ex.: vários hosts): fica por conta do driver
  }
  if (parsed.searchParams.has('sslmode') || parsed.searchParams.has('ssl') || env.PGSSLMODE) return undefined;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // Sem host (socket Unix) ou nome de um rótulo só: mesma máquina ou rede do Docker.
  if (host === '' || LOCAL_HOSTS.has(host) || !/[.:]/.test(host)) return undefined;
  return 'require';
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

/** O banco respondeu, mas faltam tabelas: esperar não resolve, é preciso rodar as migrations. */
export class DbNotMigratedError extends Error {
  override name = 'DbNotMigratedError';
}

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
    throw new DbNotMigratedError(`Banco sem as tabelas ${missing.join(', ')}: rode pnpm db:migrate.`);
  }
}

export interface WaitOptions {
  /** Por quanto tempo insistir antes de desistir (padrão: 5 minutos). */
  timeoutMs?: number;
  /** Chamado antes de cada espera, com o erro da tentativa que falhou. */
  onRetry?: (info: { attempt: number; waitMs: number; error: unknown }) => void;
  /** Erros que esperar não resolve (padrão: banco sem tabelas). */
  isFatal?: (error: unknown) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const WAIT_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * Repete `check` com espera crescente (1, 2, 4, 8 e depois 15 s) até dar certo ou até `timeoutMs`;
 * aí lança o último erro. Para o start da API e do worker quando o Postgres ainda está subindo
 * (tarefa de logon antes do Docker, redeploy correndo com o banco).
 */
export async function retryUntilReady(check: () => Promise<void>, opts: WaitOptions = {}): Promise<void> {
  const {
    timeoutMs = 5 * 60_000,
    onRetry,
    isFatal = (e) => e instanceof DbNotMigratedError,
    now = Date.now,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;
  const deadline = now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await check();
    } catch (error) {
      const left = deadline - now();
      if (isFatal(error) || left <= 0) throw error;
      const waitMs = Math.min(WAIT_STEPS_MS[Math.min(attempt - 1, WAIT_STEPS_MS.length - 1)], left);
      onRetry?.({ attempt, waitMs, error });
      await sleep(waitMs);
    }
  }
}

/** `assertDbReady` com espera: insiste enquanto o banco está inacessível; falta de tabelas falha na hora. */
export function waitForDb(db: Db, opts: WaitOptions = {}): Promise<void> {
  return retryUntilReady(() => assertDbReady(db), opts);
}

/**
 * Chave (arbitrária, fixa) do advisory lock que serializa quem lê e depois grava posições/duplicatas de
 * vagas: a inserção do worker e a renumeração de coluna da API. Use com `pg_advisory_xact_lock`.
 */
export const JOBS_WRITE_LOCK = 7461001;
