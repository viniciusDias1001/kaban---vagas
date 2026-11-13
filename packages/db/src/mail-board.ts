import { and, desc, eq, max, min, sql } from 'drizzle-orm';
import type { Actor, Column } from '@kv/shared';
import { JOBS_WRITE_LOCK, type Db } from './client';
import { alerts, jobEvents, jobs, mailIgnored, mailMessages, mailReplies } from './schema';

/** O evento mais recente do card: o que o pôs na coluna em que ele está. */
async function latestEvent(db: Db, jobId: number) {
  const [row] = await db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(desc(jobEvents.createdAt), desc(jobEvents.id))
    .limit(1);
  return row ?? null;
}

/** O que `decideMove` precisa: coluna atual, o evento que pôs o card nela e a data do último e-mail que moveu o card. */
export async function moveStateFor(
  db: Db, jobId: number,
): Promise<{ column: Column; lastMove: { actor: Actor; at: number } | null; lastDecisiveMailAt: number | null } | null> {
  const [job] = await db.select({ column: jobs.column }).from(jobs).where(eq(jobs.id, jobId));
  if (!job) return null;
  const last = await latestEvent(db, jobId);
  const [{ at }] = await db
    .select({ at: max(mailMessages.sentAt) })
    .from(jobEvents)
    .innerJoin(mailMessages, eq(mailMessages.id, jobEvents.mailMessageId))
    .where(and(eq(jobEvents.jobId, jobId), eq(jobEvents.actor, 'email')));
  return { column: job.column, lastMove: last ? { actor: last.actor, at: last.createdAt } : null, lastDecisiveMailAt: at ?? null };
}

/**
 * Põe o card no topo de `to` e grava o evento. Chamado dentro da transação, depois do lock de `JOBS_WRITE_LOCK`, que
 * serializa a leitura do topo da coluna com as outras gravações de posição (a API e a inserção de vagas).
 */
async function putOnTop(
  tx: Db, jobId: number, from: Column, to: Column, actor: Actor, mailMessageId: number | null, now: number,
): Promise<void> {
  const [{ top }] = await tx.select({ top: min(jobs.position) }).from(jobs).where(eq(jobs.column, to));
  await tx.update(jobs).set({ column: to, position: top === null ? 0 : Math.floor(top) - 1 }).where(eq(jobs.id, jobId));
  await tx.insert(jobEvents).values({ jobId, fromColumn: from, toColumn: to, actor, mailMessageId, createdAt: now });
}

const lockJobs = (tx: Db) => tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(JOBS_WRITE_LOCK))})`);

/**
 * Move para o topo de `to` com evento de autor `email` ligado à mensagem. Sem efeito (false) se o card já está em `to`
 * ou em 'arquivada'. Ao contrário da candidatura automática, pode mover para trás (uma entrevista tira o card de
 * Perdida): a regra de quando mover é de `decideMove`.
 */
export async function moveCardByEmail(
  db: Db, input: { jobId: number; to: Column; messageId: number }, now: number = Date.now(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockJobs(tx);
    const [job] = await tx.select({ column: jobs.column }).from(jobs).where(eq(jobs.id, input.jobId)).for('update');
    if (!job || job.column === input.to || job.column === 'arquivada') return false;
    await putOnTop(tx, input.jobId, job.column, input.to, 'email', input.messageId, now);
    return true;
  });
}

/**
 * Desfaz o movimento que a mensagem causou: só se o evento dela é o mais recente do card. O card volta à coluna de origem
 * com evento de autor `humano`, e a mensagem ganha `corrected = true`. Devolve false sem mexer em nada nos outros casos.
 */
export async function undoEmailMove(db: Db, messageId: number, now: number = Date.now()): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockJobs(tx);
    const [event] = await tx
      .select()
      .from(jobEvents)
      .where(and(eq(jobEvents.mailMessageId, messageId), eq(jobEvents.actor, 'email')))
      .orderBy(desc(jobEvents.createdAt), desc(jobEvents.id))
      .limit(1);
    if (!event?.fromColumn) return false;
    const [job] = await tx.select({ column: jobs.column }).from(jobs).where(eq(jobs.id, event.jobId)).for('update');
    const last = await latestEvent(tx, event.jobId);
    if (!job || last?.id !== event.id || job.column !== event.toColumn) return false;
    await putOnTop(tx, event.jobId, job.column, event.fromColumn, 'humano', null, now);
    await tx.update(mailMessages).set({ corrected: true }).where(eq(mailMessages.id, messageId));
    return true;
  });
}

/**
 * Apaga mensagens (com respostas e alertas), ignorados e alertas restantes. A caixa e a credencial ficam. Os eventos dos
 * cards ficam também: a chave estrangeira solta a ligação com a mensagem apagada.
 */
export async function deleteMailData(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(alerts);
    await tx.delete(mailReplies);
    await tx.delete(mailMessages);
    await tx.delete(mailIgnored);
  });
}
