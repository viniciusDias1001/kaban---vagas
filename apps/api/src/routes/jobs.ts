import { and, asc, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JOBS_WRITE_LOCK, applicationForJob, jobEvents, jobs, listJobItems, requestCancel, settleAppliedByOwner, type Db } from '@kv/db';
import {
  ColumnSchema, JobPatchSchema, LIMITS, hasNul, isAppliedOrLater, type Column, type JobDto, type JobListItemDto,
} from '@kv/shared';
import type { AiContext } from '../ai-context';
import { intendedIndex } from '../position';
import { idParam, parseId } from './ids';
import { requestAnalysis } from './job-ai';

const notFound = { error: 'not_found', message: 'vaga não encontrada' };

const queryText = (max: number) =>
  z.string().max(max).refine((s) => !hasNul(s), 'não pode conter o caractere NUL');

/**
 * Filtros de `GET /jobs`. Cada parâmetro vale uma vez só: repetido (`?q=a&q=b`), ele chega como lista e
 * a validação responde 400. Parâmetros desconhecidos são ignorados.
 */
const JobsQuerySchema = z.object({
  column: ColumnSchema.optional(),
  profile: z.string().max(20).optional(),
  source: queryText(LIMITS.sourceIdLength).optional(),
  q: queryText(LIMITS.search).optional(),
});

/** `%`, `_` e a barra invertida são curingas/escape do LIKE: escapados, casam literalmente. */
export const escapeLike = (term: string) => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export function jobRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  app.get('/jobs', async (req): Promise<JobListItemDto[]> => {
    // Parâmetro vazio (`?q=`) é o mesmo que ausente.
    const raw = Object.fromEntries(Object.entries(req.query as Record<string, unknown>).filter(([, v]) => v !== ''));
    const query = JobsQuerySchema.parse(raw);
    const where: SQL[] = [];
    if (query.column) where.push(eq(jobs.column, query.column));
    if (query.profile) {
      const profileId = parseId(query.profile);
      if (profileId === null) return [];
      where.push(eq(jobs.profileId, profileId));
    }
    if (query.source) where.push(eq(jobs.source, query.source));
    if (query.q) {
      const term = `%${escapeLike(query.q)}%`;
      where.push(or(ilike(jobs.title, term), ilike(jobs.company, term))!);
    }
    // Sem a descrição nem o dedupHash; cada vaga vem com o estado da candidatura dela (null sem candidatura), que o
    // quadro usa nos selos.
    return listJobItems(db, and(...where));
  });

  app.get('/jobs/:id', async (req, reply) => {
    const id = idParam(req);
    if (id === null) return reply.code(404).send(notFound);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    if (!job) return reply.code(404).send(notFound);
    const events = await db.select().from(jobEvents).where(eq(jobEvents.jobId, id)).orderBy(asc(jobEvents.id));
    const application = await applicationForJob(db, id);
    const dto: JobDto = { ...job, applicationStatus: application?.status ?? null };
    return { job: dto, events };
  });

  app.patch('/jobs/:id', async (req, reply) => {
    const id = idParam(req);
    const patch = JobPatchSchema.parse(req.body);
    if (id === null) return reply.code(404).send(notFound);

    const updated = await db.transaction(async (tx) => {
      // Quem mexe em posição entra em fila (o mesmo lock da inserção de vagas do worker): a renumeração
      // abaixo atualiza a coluna inteira, e dois PATCH fazendo isso ao mesmo tempo travariam um ao outro.
      // Vem antes do FOR UPDATE para a ordem dos locks ser sempre a mesma.
      if (patch.position !== undefined) {
        await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(JOBS_WRITE_LOCK))})`);
      }
      // FOR UPDATE: dois PATCH simultâneos na mesma vaga não gravam eventos com `fromColumn` errado.
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
      if (!job) return null;

      const set: Partial<typeof jobs.$inferInsert> = {};
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.position !== undefined) {
        set.position = await resolvePosition(tx, id, patch.column ?? job.column, patch.position);
      }
      if (patch.column && patch.column !== job.column) {
        set.column = patch.column;
        if (patch.column === 'aplicada' && !job.appliedBy) set.appliedBy = 'humano';
        // O dono mexeu no card: a candidatura automática para (ou é cancelada) e a marca de "precisa de você" sai. Para
        // Aplicada ou depois o dono já se candidatou: a candidatura parada termina como "aplicada por você" (`skipped` /
        // `already_applied`), não como cancelada, e nunca é tentada de novo.
        set.needsHuman = false;
        set.needsHumanReason = null;
        if (isAppliedOrLater(patch.column)) await settleAppliedByOwner(tx, id);
        else await requestCancel(tx, id);
        await tx
          .insert(jobEvents)
          .values({ jobId: id, fromColumn: job.column, toColumn: patch.column, actor: 'humano', createdAt: Date.now() });
      } else if (patch.column && isAppliedOrLater(patch.column)) {
        // "Já apliquei por conta própria" com o card já em Aplicada (ou depois): o card não muda de coluna, mas a
        // candidatura parada é encerrada do mesmo jeito.
        if (patch.column === 'aplicada' && !job.appliedBy) set.appliedBy = 'humano';
        await settleAppliedByOwner(tx, id);
      }
      if (Object.keys(set).length === 0) return job;
      const [row] = await tx.update(jobs).set(set).where(eq(jobs.id, id)).returning();
      return row;
    });
    if (!updated) return reply.code(404).send(notFound);
    const application = await applicationForJob(db, id);
    const dto: JobDto = { ...updated, applicationStatus: application?.status ?? null };
    // Mover para Selecionadas pede a análise da vaga (camadas 1 e 2). É idempotente, e uma falha aqui
    // não desfaz o movimento do card.
    if (patch.column === 'selecionadas') {
      await requestAnalysis(db, ctx, id, { auto: true }).catch((e) =>
        console.error(`[api] análise da vaga ${id} não enfileirada: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    return dto;
  });
}

/**
 * A posição a gravar para o card `id` na coluna `column`. Normalmente é a pedida. Se ela é igual à de
 * outro card da coluna (o ponto médio calculado pelo quadro ficou sem precisão de ponto flutuante), a
 * coluna é renumerada para inteiros consecutivos (0, 1, 2, ...) na ordem visual atual, com um lugar
 * reservado para o card movido onde o cliente quis soltá-lo; devolve esse lugar. É também o que
 * normaliza, na primeira vez que importa, colunas antigas com posições enormes (`-Date.now()`).
 */
async function resolvePosition(tx: Db, id: number, column: Column, requested: number): Promise<number> {
  const others = and(eq(jobs.column, column), ne(jobs.id, id));
  const [collision] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(others, eq(jobs.position, requested)))
    .limit(1);
  if (!collision) return requested;

  const neighbours = await tx
    .select({ position: jobs.position })
    .from(jobs)
    .where(others)
    .orderBy(asc(jobs.position), asc(jobs.id));
  const index = intendedIndex(neighbours.map((n) => n.position), requested);
  await tx.execute(sql`
    update jobs
       set position = ranked.rank + case when ranked.rank >= ${index} then 1 else 0 end
      from (
        select id, row_number() over (order by position, id) - 1 as rank
          from jobs
         where board_column = ${column} and id <> ${id}
      ) ranked
     where jobs.id = ranked.id`);
  return index;
}
