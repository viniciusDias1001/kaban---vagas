import { eq, inArray, sql } from 'drizzle-orm';
import { detectLevel, matchesFilters, type Connector } from '@kv/connectors';
import { jobEvents, jobs, runs, searchProfiles, type Db } from '@kv/db';
import type { NormalizedJob, SearchFilters } from '@kv/shared';
import { dedupHash } from './dedup';

export interface RunOptions {
  timeoutMs?: number;
  retries?: number;
}

/** Linhas por INSERT: mantém o número de parâmetros bem abaixo do limite do Postgres (65 534). */
const CHUNK = 500;

/** Chave (arbitrária, fixa) do advisory lock que serializa a deduplicação de vagas entre runs. */
const INSERT_JOBS_LOCK = '7461001';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout após ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function searchWithRetry(connector: Connector, filters: SearchFilters, timeoutMs: number, retries: number) {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(connector.search(filters), timeoutMs);
    } catch (e) {
      last = e;
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
 * Grava as vagas ainda não vistas na coluna descobertas. Devolve quantas inseriu.
 *
 * Duplicatas entre fontes (mesmo `dedup_hash`) são descartadas por uma consulta prévia, feita sob um
 * advisory lock na mesma transação do INSERT. Duplicatas por URL ficam a cargo do índice único
 * `jobs_url_idx` + ON CONFLICT DO NOTHING, seguro mesmo com outro processo inserindo ao mesmo tempo;
 * o evento de histórico só é gravado para as linhas que o INSERT devolveu.
 */
export async function insertNewJobs(db: Db, profileId: number, found: NormalizedJob[]): Promise<number> {
  const now = Date.now();
  const seen = new Set<string>();
  const candidates: (typeof jobs.$inferInsert)[] = [];
  found.forEach((job, i) => {
    const hash = dedupHash(job);
    if (seen.has(hash)) return;
    seen.add(hash);
    candidates.push({
      ...job,
      level: detectLevel(job.title),
      discoveredAt: now,
      dedupHash: hash,
      profileId,
      column: 'descobertas',
      position: -now + i,
    });
  });

  let inserted = 0;
  for (const batch of chunks(candidates, CHUNK)) {
    inserted += await db.transaction(async (tx) => {
      // `dedup_hash` não é único no banco, então "consultar e depois inserir" precisa ser serializado:
      // os runs das várias fontes rodam em paralelo e duas delas podem trazer a mesma vaga com URLs
      // diferentes. O lock vale até o fim desta transação (funciona também atrás do pooler do Supabase).
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(INSERT_JOBS_LOCK)})`);
      const known = await tx
        .select({ hash: jobs.dedupHash })
        .from(jobs)
        .where(inArray(jobs.dedupHash, batch.map((j) => j.dedupHash)));
      const knownHashes = new Set(known.map((k) => k.hash));
      const fresh = batch.filter((j) => !knownHashes.has(j.dedupHash));
      if (fresh.length === 0) return 0;

      const rows = await tx
        .insert(jobs)
        .values(fresh)
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
  const { timeoutMs = 60_000, retries = 1 } = opts;
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
      const all = await searchWithRetry(connector, filters, timeoutMs, retries);
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
    // O próprio banco falhou (ex.: conexão caiu) e não há onde registrar: o run fica como está e
    // `failStaleRuns` o encerra no próximo start do worker.
    console.error(`[worker] run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
