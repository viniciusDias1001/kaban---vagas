import { and, eq, inArray, min, sql } from 'drizzle-orm';
import { JOBS_WRITE_LOCK, applications, jobEvents, jobs, type Db } from '@kv/db';
import { COLUMNS, type Column, type NeedsHumanReason, type SkipReason } from '@kv/shared';

type Actor = typeof jobEvents.$inferInsert.actor;

/** Até onde o card avançou: Descartada conta como o começo (a vaga foi posta de lado sem candidatura). */
const progress = (column: Column): number => (column === 'descartada' ? 0 : COLUMNS.indexOf(column));
/** A regra de sempre: só avança, nunca tira um card da coluna em que está nem de uma posterior. */
const ahead = (to: Column) => (column: Column) => progress(column) < progress(to);

/**
 * Move o card para o topo de `to` com um evento do ator dado, e grava `applied_by` em `aplicada` se ainda não há; só se
 * `canMove` aceita a coluna em que o card está, relida dentro da transação (um movimento do dono um instante antes vence).
 * O lock de `JOBS_WRITE_LOCK` serializa a leitura do topo da coluna com as outras gravações de posição (a API e a inserção
 * de vagas). Devolve se moveu.
 */
async function moveToTop(
  db: Db, jobId: number, to: Column, actor: Actor, appliedBy: 'ia' | 'humano' | null, now: number,
  canMove: (column: Column) => boolean = ahead(to),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(JOBS_WRITE_LOCK))})`);
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('update');
    if (!job || job.column === to || !canMove(job.column)) return false;
    const [{ top }] = await tx.select({ top: min(jobs.position) }).from(jobs).where(eq(jobs.column, to));
    await tx
      .update(jobs)
      .set({ column: to, position: top === null ? 0 : Math.floor(top) - 1, ...(appliedBy && !job.appliedBy ? { appliedBy } : {}) })
      .where(eq(jobs.id, jobId));
    await tx.insert(jobEvents).values({ jobId, fromColumn: job.column, toColumn: to, actor, createdAt: now });
    return true;
  });
}

/**
 * Move o card para o topo da coluna, com evento de ator `ia`; em `aplicada`, grava `applied_by = 'ia'`. Não move um card que
 * já está em coluna posterior. Tira o card de Descartada (o dono mandou tentar de novo uma vaga posta de lado).
 */
export async function moveCardByAi(db: Db, jobId: number, to: 'selecionadas' | 'aplicada', now: number = Date.now()): Promise<void> {
  await moveToTop(db, jobId, to, 'ia', to === 'aplicada' ? 'ia' : null, now);
}

/** O site informou que o dono já se candidatou: `aplicada`, `applied_by = 'humano'`, evento de ator `sistema`. */
export async function markAppliedByOwner(db: Db, jobId: number, now: number = Date.now()): Promise<void> {
  await moveToTop(db, jobId, 'aplicada', 'sistema', 'humano', now);
}

/** Os motivos de pulo que põem o card de lado em Descartada. Os outros (`blocked`, `external`, `already_applied`) não o movem. */
export const DISCARD_REASONS = ['below_min_score', 'not_eligible', 'closed'] as const satisfies readonly SkipReason[];
const discards = (reason: SkipReason): boolean => (DISCARD_REASONS as readonly SkipReason[]).includes(reason);

/** Põe o card no topo de Descartada, com evento de ator `ia`, só se ele ainda está numa das colunas `from`. */
function moveToDiscarded(db: Db, jobId: number, from: readonly Column[], now: number): Promise<boolean> {
  return moveToTop(db, jobId, 'descartada', 'ia', null, now, (column) => from.includes(column));
}

/**
 * Uma candidatura terminou pulada: com um dos `DISCARD_REASONS`, o card vai para o topo de Descartada, mas só se ainda está
 * em Descobertas ou Selecionadas (nunca um card que o dono já levou para outra coluna). Devolve se moveu.
 */
export function discardSkipped(db: Db, jobId: number, reason: SkipReason, now: number = Date.now()): Promise<boolean> {
  if (!discards(reason)) return Promise.resolve(false);
  return moveToDiscarded(db, jobId, ['descobertas', 'selecionadas'], now);
}

/**
 * Recuperação das candidaturas puladas antes de Descartada existir, a cada varredura da fila: cards em Descobertas com
 * candidatura `skipped` por um dos `DISCARD_REASONS` vão para Descartada do mesmo jeito. Um card que já esteve em Descartada
 * (o dono o tirou de lá) fica onde está. Devolve quantos moveu.
 */
export async function discardSkippedCards(db: Db, now: number = Date.now()): Promise<number> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(applications, eq(applications.jobId, jobs.id))
    .where(
      and(
        eq(jobs.column, 'descobertas'),
        eq(applications.status, 'skipped'),
        inArray(applications.reason, [...DISCARD_REASONS]),
        sql`not exists (select 1 from ${jobEvents} where ${jobEvents.jobId} = ${jobs.id} and ${jobEvents.toColumn} = 'descartada')`,
      ),
    );
  let moved = 0;
  for (const { id } of rows) if (await moveToDiscarded(db, id, ['descobertas'], now)) moved += 1;
  return moved;
}

/** Liga a marca "precisa de você" do card com o texto, ou a desliga com `null`. */
export async function setNeedsHuman(db: Db, jobId: number, text: string | null): Promise<void> {
  await db.update(jobs).set({ needsHuman: text !== null, needsHumanReason: text }).where(eq(jobs.id, jobId));
}

const NEEDS_HUMAN_TEXTS: Record<NeedsHumanReason, string> = {
  question: 'Há uma pergunta do formulário que só você pode responder.',
  captcha: 'O site pediu para você resolver uma verificação (captcha).',
  verification_code: 'O site enviou um código de verificação para você digitar.',
  login: 'É preciso entrar na sua conta no site.',
  restricted: 'O site restringiu a conta: a candidatura automática foi pausada.',
  unsupported_form: 'O formulário tem um formato que o app não sabe preencher.',
  resume_blocked: 'Não foi possível montar o currículo desta candidatura.',
  confirm_submission: 'Confira a candidatura e confirme o envio.',
};

/** Frase fixa em pt-BR para cada motivo, com o detalhe quando há. */
export function needsHumanText(reason: NeedsHumanReason, detail: string | null): string {
  const text = NEEDS_HUMAN_TEXTS[reason];
  return detail ? `${text} ${detail}` : text;
}
