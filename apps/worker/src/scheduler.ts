import { and, eq, gt } from 'drizzle-orm';
import type { Connector } from '@kv/connectors';
import { enqueueRuns, runs, searchProfiles, type Db } from '@kv/db';
import { executeRun } from './runner';

const HOUR = 3_600_000;

/** Verdadeiro se nenhum run terminou com sucesso na última hora. */
export async function isDue(db: Db, now: number = Date.now()): Promise<boolean> {
  const recent = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, 'ok'), gt(runs.finishedAt, now - HOUR)))
    .limit(1);
  return recent.length === 0;
}

/** Enfileira um run por fonte de cada perfil ativo. Devolve quantos enfileirou. */
export async function enqueueAllActive(db: Db): Promise<number> {
  const profiles = await db.select().from(searchProfiles).where(eq(searchProfiles.active, true));
  let total = 0;
  for (const p of profiles) total += await enqueueRuns(db, p, 'cron');
  return total;
}

/** Executa em paralelo todos os runs na fila. Devolve quantos executou. */
export async function processQueue(db: Db, connectors: Connector[]): Promise<number> {
  const queued = await db.select({ id: runs.id }).from(runs).where(eq(runs.status, 'queued'));
  await Promise.all(queued.map((r) => executeRun(db, r.id, connectors)));
  return queued.length;
}

/** Runs que ficaram em "running" de um processo anterior viram erro. */
export async function failStaleRuns(db: Db): Promise<void> {
  await db
    .update(runs)
    .set({ status: 'error', error: 'worker reiniciado', finishedAt: Date.now() })
    .where(eq(runs.status, 'running'));
}

export function msUntilNextHour(now: number = Date.now()): number {
  return HOUR - (now % HOUR);
}

/** Chama `fn` a cada hora cheia, para sempre. */
export function scheduleHourly(fn: () => void): void {
  setTimeout(() => {
    fn();
    scheduleHourly(fn);
  }, msUntilNextHour());
}
