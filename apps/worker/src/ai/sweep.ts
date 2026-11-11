import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { aiTasks, baseProfile, jobAi, jobSubject, jobs, type Db } from '@kv/db';

/**
 * Enfileira a camada 1 das vagas que ainda não têm linha em `job_ai` (vagas novas), das mais recentes
 * para as mais antigas, no máximo `limit` por chamada. Só roda quando existe perfil. Vagas arquivadas
 * ficam de fora. Notas desatualizadas NÃO entram aqui: são refeitas quando a vaga é aberta ou movida.
 *
 * Um INSERT só, idempotente pelo índice único parcial de tarefas pendentes. Devolve quantas enfileirou.
 */
export async function enqueueTier1ForNewJobs(db: Db, limit = 50, now: number = Date.now()): Promise<number> {
  if (!(await baseProfile(db))) return 0;
  const fresh = await db
    .select({ id: jobs.id })
    .from(jobs)
    .leftJoin(jobAi, eq(jobAi.jobId, jobs.id))
    .where(and(isNull(jobAi.jobId), ne(jobs.column, 'arquivada')))
    .orderBy(desc(jobs.id))
    .limit(limit);
  if (fresh.length === 0) return 0;
  const inserted = await db
    .insert(aiTasks)
    .values(fresh.map((j) => ({ type: 'tier1' as const, subject: jobSubject(j.id), jobId: j.id, status: 'queued' as const, createdAt: now })))
    .onConflictDoNothing()
    .returning({ id: aiTasks.id });
  return inserted.length;
}
