import { and, desc, eq, isNull, notInArray, or, sql } from 'drizzle-orm';
import { AI_PENDING, aiTasks, baseProfile, jobAi, jobSubject, jobs, type Db } from '@kv/db';

/** Uma vaga cuja camada 1 falhou só volta para a fila sozinha depois deste tempo. */
export const TIER1_RETRY_AFTER_MS = 6 * 3_600_000;
/**
 * Quantas falhas definitivas da camada 1 uma vaga pode ter antes de a varredura desistir dela (a primeira mais três
 * novas tentativas automáticas). A conta olha as tarefas com erro guardadas em `ai_tasks`, que a fila apaga depois
 * de 30 dias: uma vaga que falha sempre é tentada no máximo quatro vezes a cada 30 dias.
 */
export const TIER1_MAX_FAILURES = 4;

const PENDING = sql.join(AI_PENDING.map((s) => sql`${s}`), sql`, `);

/**
 * Enfileira a camada 1 das vagas que precisam dela, das mais recentes para as mais antigas, no máximo `limit` por
 * chamada. Só roda quando existe perfil. Vagas arquivadas, perdidas e descartadas ficam de fora. Entram:
 * - vagas novas (sem linha em `job_ai`, ou com linha mas sem desfecho da camada 1);
 * - vagas cuja camada 1 terminou em ERRO há mais de TIER1_RETRY_AFTER_MS, enquanto não chegarem a
 *   TIER1_MAX_FAILURES falhas. Sem isto, uma falha passageira (ou um provedor fora do ar por um tempo) tirava a
 *   vaga da triagem para sempre.
 * Notas desatualizadas NÃO entram aqui: são refeitas quando a vaga é aberta ou movida. Quem já tem tarefa da
 * camada 1 pendente também não.
 *
 * Um INSERT só, idempotente pelo índice único parcial de tarefas pendentes. Devolve quantas enfileirou.
 */
export async function enqueueTier1ForNewJobs(db: Db, limit = 50, now: number = Date.now()): Promise<number> {
  if (!(await baseProfile(db))) return 0;
  const failures = sql`(select count(*) from ${aiTasks} t where t.job_id = ${jobs.id} and t.type = 'tier1' and t.status = 'error')`;
  const lastFailure = sql`(select max(t.finished_at) from ${aiTasks} t where t.job_id = ${jobs.id} and t.type = 'tier1' and t.status = 'error')`;
  const pending = sql`exists (select 1 from ${aiTasks} t where t.job_id = ${jobs.id} and t.type = 'tier1' and t.status in (${PENDING}))`;
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .leftJoin(jobAi, eq(jobAi.jobId, jobs.id))
    .where(
      and(
        notInArray(jobs.column, ['arquivada', 'perdida', 'descartada']),
        sql`not ${pending}`,
        or(
          isNull(jobAi.jobId),
          isNull(jobAi.tier1State),
          and(eq(jobAi.tier1State, 'error'), sql`${failures} < ${TIER1_MAX_FAILURES}`, sql`coalesce(${lastFailure} < ${new Date(now - TIER1_RETRY_AFTER_MS).toISOString()}::timestamptz, true)`),
        ),
      ),
    )
    .orderBy(desc(jobs.id))
    .limit(limit);
  const fresh = rows.map((r) => r.id);
  if (fresh.length === 0) return 0;
  const inserted = await db
    .insert(aiTasks)
    .values(fresh.map((id) => ({ type: 'tier1' as const, subject: jobSubject(id), jobId: id, status: 'queued' as const, createdAt: now })))
    .onConflictDoNothing()
    .returning({ id: aiTasks.id });
  return inserted.length;
}
