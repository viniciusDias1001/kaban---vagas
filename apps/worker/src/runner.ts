import { eq, inArray, min, sql } from 'drizzle-orm';
import { MAX_DESCRIPTION_CHARS, detectLevel, matchesFilters, type Connector, type ConnectorConfig } from '@kv/connectors';
import { JOBS_WRITE_LOCK, jobEvents, jobs, runs, searchProfiles, type Db } from '@kv/db';
import { COMPANY_SLUG_PATTERN, SETTINGS_LIMITS, type NormalizedJob, type SearchFilters } from '@kv/shared';
import { dedupHash } from './dedup';

export interface RunOptions {
  /** Limite de cada tentativa de busca (padrão 60 s). */
  timeoutMs?: number;
  /** Novas tentativas depois da primeira (padrão 1). */
  retries?: number;
  /** Depois de abortar uma tentativa que estourou o tempo, quanto esperar ela terminar (padrão 2 s). */
  abortGraceMs?: number;
  /**
   * Configuração entregue aos conectores (listas de empresas do Greenhouse e do Lever), lida a cada run:
   * uma mudança na aba Configurações vale na próxima busca. Se a leitura falhar, o run termina em erro.
   */
  connectorConfig?: () => Promise<ConnectorConfig>;
  /** Avisos do run (ex.: empresa descartada da lista por nome inválido). */
  log?: (msg: string) => void;
}

const DEFAULTS = { timeoutMs: 60_000, retries: 1, abortGraceMs: 2_000 } as const;

/** Teto do tempo que um run passa buscando na fonte: todas as tentativas, cada uma com timeout e folga. */
export function maxSearchMs(opts: RunOptions = {}): number {
  const { timeoutMs, retries, abortGraceMs } = { ...DEFAULTS, ...opts };
  return (timeoutMs + abortGraceMs) * (retries + 1);
}

/** Linhas por INSERT: mantém o número de parâmetros bem abaixo do limite do Postgres (65 534). */
const CHUNK = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Descrição de uma vaga no teto de MAX_DESCRIPTION_CHARS, sem cortar um par substituto (emoji) ao meio. */
function clipDescription(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  let end = MAX_DESCRIPTION_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end).trimEnd();
}

const isSlug = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= SETTINGS_LIMITS.companySlug && COMPANY_SLUG_PATTERN.test(value);

/** Valor para o log: entre aspas, sem quebra de linha e curto. */
const shown = (value: unknown) => JSON.stringify(String(value).slice(0, 40));

/**
 * Os nomes de empresa do Greenhouse e do Lever entram direto na URL (`.../boards/<nome>/jobs`). A aba
 * Configurações já valida o que grava, mas a lista também pode vir do ambiente (`GREENHOUSE_BOARDS`,
 * `LEVER_COMPANIES`) ou de uma linha antiga do banco: antes de chegar ao conector, tudo o que não tem a forma de
 * um nome simples (letras minúsculas, dígitos, `-` e `_`) é descartado, com uma linha de log. Se a lista inteira
 * for descartada, o conector usa o ambiente e o padrão, como faz com uma lista vazia.
 */
export function sanitizeConnectorConfig(config: ConnectorConfig | undefined, log: (msg: string) => void = () => {}): ConnectorConfig | undefined {
  if (!config) return config;
  const clean = (name: string, list: readonly string[] | undefined) => {
    if (!list) return list;
    const kept = list.filter((slug) => {
      if (isSlug(slug)) return true;
      log(`busca: nome de empresa inválido descartado da lista ${name} (slug): ${shown(slug)}`);
      return false;
    });
    if (list.length > 0 && kept.length === 0) log(`busca: toda a lista ${name} foi descartada; valem o ambiente e o padrão`);
    return kept;
  };
  return { ...config, greenhouseBoards: clean('greenhouseBoards', config.greenhouseBoards), leverCompanies: clean('leverCompanies', config.leverCompanies) };
}

/**
 * Uma tentativa por vez: a seguinte só começa depois que a anterior terminou. Uma tentativa que estoura
 * `timeoutMs` tem o `signal` abortado (os conectores o repassam às requisições, que são canceladas) e
 * ganha `abortGraceMs` para terminar; só então vem a próxima.
 */
async function searchWithRetry(
  connector: Connector,
  filters: SearchFilters,
  opts: Required<Omit<RunOptions, 'connectorConfig' | 'log'>>,
  config?: ConnectorConfig,
) {
  const { timeoutMs, retries, abortGraceMs } = opts;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const search = Promise.resolve().then(() => connector.search(filters, controller.signal, config));
    const settled = search.then(
      () => {},
      () => {},
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout após ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([search, timeout]);
    } catch (e) {
      last = e;
      if (!controller.signal.aborted) {
        // Se foi o timeout, a busca ainda está em curso: cancela e espera (um pouco) ela terminar.
        controller.abort(e);
        await Promise.race([settled, sleep(abortGraceMs)]);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Grava as vagas ainda não vistas no topo da coluna descobertas, na ordem em que vieram. Devolve quantas
 * inseriu.
 *
 * Posições são números pequenos: as novas ficam logo acima do topo atual (`min(position) - n … - 1`, ou
 * `0 … n-1` na coluna vazia). Com magnitudes pequenas sobra precisão de ponto flutuante para o quadro
 * encaixar um card entre dois vizinhos (ponto médio) dezenas de vezes seguidas.
 *
 * Duplicatas entre fontes (mesmo `dedup_hash`) são descartadas por uma consulta prévia, feita sob um
 * advisory lock na mesma transação do INSERT. Duplicatas por URL ficam a cargo do índice único
 * `jobs_url_idx` + ON CONFLICT DO NOTHING, seguro mesmo com outro processo inserindo ao mesmo tempo;
 * o evento de histórico só é gravado para as linhas que o INSERT devolveu.
 */
export async function insertNewJobs(db: Db, profileId: number, found: NormalizedJob[]): Promise<number> {
  const now = Date.now();
  const seen = new Set<string>();
  const candidates: Omit<typeof jobs.$inferInsert, 'position'>[] = [];
  found.forEach((job) => {
    const hash = dedupHash(job);
    if (seen.has(hash)) return;
    seen.add(hash);
    candidates.push({
      ...job,
      description: clipDescription(job.description),
      level: detectLevel(job.title),
      discoveredAt: now,
      dedupHash: hash,
      profileId,
      column: 'descobertas',
    });
  });

  let inserted = 0;
  // Do último lote para o primeiro: cada lote entra acima do anterior, e o início da lista termina no topo.
  for (const batch of chunks(candidates, CHUNK).reverse()) {
    inserted += await db.transaction(async (tx) => {
      // `dedup_hash` não é único no banco, então "consultar e depois inserir" precisa ser serializado:
      // os runs das várias fontes rodam em paralelo e duas delas podem trazer a mesma vaga com URLs
      // diferentes. O lock vale até o fim desta transação (funciona também atrás do pooler do Supabase).
      // O mesmo lock protege a leitura do topo da coluna, logo abaixo.
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(JOBS_WRITE_LOCK))})`);
      const known = await tx
        .select({ hash: jobs.dedupHash })
        .from(jobs)
        .where(inArray(jobs.dedupHash, batch.map((j) => j.dedupHash)));
      const knownHashes = new Set(known.map((k) => k.hash));
      const fresh = batch.filter((j) => !knownHashes.has(j.dedupHash));
      if (fresh.length === 0) return 0;

      const [{ top }] = await tx.select({ top: min(jobs.position) }).from(jobs).where(eq(jobs.column, 'descobertas'));
      const first = top === null ? 0 : Math.floor(top) - fresh.length;
      const rows = await tx
        .insert(jobs)
        .values(fresh.map((j, i) => ({ ...j, position: first + i })))
        .onConflictDoNothing({ target: jobs.url })
        .returning({ id: jobs.id });
      if (rows.length > 0) {
        await tx.insert(jobEvents).values(
          rows.map((r) => ({
            jobId: r.id, fromColumn: null, toColumn: 'descobertas' as const, actor: 'sistema' as const, createdAt: now,
          })),
        );
      }
      return rows.length;
    });
  }
  return inserted;
}

/** Executa um run enfileirado. Nunca lança: falhas ficam registradas na linha do run. */
export async function executeRun(db: Db, runId: number, connectors: Connector[], opts: RunOptions = {}): Promise<void> {
  const options = { ...DEFAULTS, ...opts };
  try {
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (!run) return;
    await db.update(runs).set({ status: 'running', startedAt: Date.now() }).where(eq(runs.id, runId));
    try {
      const [profile] = await db.select().from(searchProfiles).where(eq(searchProfiles.id, run.profileId));
      if (!profile) throw new Error(`perfil ${run.profileId} não existe`);
      const connector = connectors.find((c) => c.id === run.source);
      if (!connector) throw new Error(`conector desconhecido: ${run.source}`);
      const filters: SearchFilters = {
        stacks: profile.stacks,
        levels: profile.levels,
        maxAgeDays: profile.maxAgeDays,
        regions: profile.regions,
      };
      const config = sanitizeConnectorConfig(await opts.connectorConfig?.(), opts.log);
      const all = await searchWithRetry(connector, filters, options, config);
      const found = all.filter((j) => matchesFilters(j, filters));
      const inserted = await insertNewJobs(db, profile.id, found);
      await db
        .update(runs)
        .set({ status: 'ok', found: found.length, inserted, finishedAt: Date.now() })
        .where(eq(runs.id, runId));
    } catch (e) {
      await db
        .update(runs)
        .set({ status: 'error', error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() })
        .where(eq(runs.id, runId));
    }
  } catch (e) {
    // O próprio banco falhou (ex.: conexão caiu) e não há onde registrar: o run fica como está ("running")
    // e a fila o encerra depois (`reapStaleRuns`, a cada verificação) ou no próximo start (`failStaleRuns`).
    console.error(`[worker] run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
