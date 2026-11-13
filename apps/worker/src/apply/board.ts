import { eq, min, sql } from 'drizzle-orm';
import { JOBS_WRITE_LOCK, jobEvents, jobs, type Db } from '@kv/db';
import { COLUMNS, type Column, type NeedsHumanReason } from '@kv/shared';

type Actor = typeof jobEvents.$inferInsert.actor;

/**
 * Move o card para o topo de `to` com um evento do ator dado, e grava `applied_by` em `aplicada` se ainda não há. Não
 * move um card que já está na coluna ou em coluna posterior. O lock de `JOBS_WRITE_LOCK` serializa a leitura do topo da
 * coluna com as outras gravações de posição (a API e a inserção de vagas).
 */
async function moveToTop(db: Db, jobId: number, to: Column, actor: Actor, appliedBy: 'ia' | 'humano' | null, now: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(JOBS_WRITE_LOCK))})`);
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for('update');
    if (!job || COLUMNS.indexOf(job.column) >= COLUMNS.indexOf(to)) return;
    const [{ top }] = await tx.select({ top: min(jobs.position) }).from(jobs).where(eq(jobs.column, to));
    await tx
      .update(jobs)
      .set({ column: to, position: top === null ? 0 : Math.floor(top) - 1, ...(appliedBy && !job.appliedBy ? { appliedBy } : {}) })
      .where(eq(jobs.id, jobId));
    await tx.insert(jobEvents).values({ jobId, fromColumn: job.column, toColumn: to, actor, createdAt: now });
  });
}

/** Move o card para o topo da coluna, com evento de ator `ia`; em `aplicada`, grava `applied_by = 'ia'`. Não move um card que já está em coluna posterior. */
export function moveCardByAi(db: Db, jobId: number, to: 'selecionadas' | 'aplicada', now: number = Date.now()): Promise<void> {
  return moveToTop(db, jobId, to, 'ia', to === 'aplicada' ? 'ia' : null, now);
}

/** O site informou que o dono já se candidatou: `aplicada`, `applied_by = 'humano'`, evento de ator `sistema`. */
export function markAppliedByOwner(db: Db, jobId: number, now: number = Date.now()): Promise<void> {
  return moveToTop(db, jobId, 'aplicada', 'sistema', 'humano', now);
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
