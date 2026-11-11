import { eq, or } from 'drizzle-orm';
import { detectLevel, matchesFilters, type Connector } from '@kv/connectors';
import { jobEvents, jobs, runs, searchProfiles, type Db } from '@kv/db';
import type { NormalizedJob, SearchFilters } from '@kv/shared';
import { dedupHash } from './dedup';

export interface RunOptions {
  timeoutMs?: number;
  retries?: number;
}

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

/** Grava as vagas ainda não vistas na coluna descobertas. Devolve quantas inseriu. */
export function insertNewJobs(db: Db, profileId: number, found: NormalizedJob[]): number {
  const now = Date.now();
  let inserted = 0;
  found.forEach((job, i) => {
    const hash = dedupHash(job);
    const dup = db.select({ id: jobs.id }).from(jobs).where(or(eq(jobs.url, job.url), eq(jobs.dedupHash, hash))).get();
    if (dup) return;
    const row = db
      .insert(jobs)
      .values({
        ...job,
        level: detectLevel(job.title),
        discoveredAt: now,
        dedupHash: hash,
        profileId,
        column: 'descobertas',
        position: -now + i,
      })
      .returning({ id: jobs.id })
      .get();
    db.insert(jobEvents)
      .values({ jobId: row.id, fromColumn: null, toColumn: 'descobertas', actor: 'sistema', createdAt: now })
      .run();
    inserted++;
  });
  return inserted;
}

/** Executa um run enfileirado. Nunca lança: falhas ficam registradas na linha do run. */
export async function executeRun(db: Db, runId: number, connectors: Connector[], opts: RunOptions = {}): Promise<void> {
  const { timeoutMs = 60_000, retries = 1 } = opts;
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return;
  db.update(runs).set({ status: 'running', startedAt: Date.now() }).where(eq(runs.id, runId)).run();
  try {
    const profile = db.select().from(searchProfiles).where(eq(searchProfiles.id, run.profileId)).get();
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
    const inserted = insertNewJobs(db, profile.id, found);
    db.update(runs)
      .set({ status: 'ok', found: found.length, inserted, finishedAt: Date.now() })
      .where(eq(runs.id, runId))
      .run();
  } catch (e) {
    db.update(runs)
      .set({ status: 'error', error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() })
      .where(eq(runs.id, runId))
      .run();
  }
}
