import { and, asc, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { AlertDto, AlertKind, AlertPayload, JobMailMarks } from '@kv/shared';
import type { Db } from './client';
import { alerts, jobs, mailMessages, mailReplies } from './schema';

export type AlertRow = typeof alerts.$inferSelect;

/**
 * Chave (arbitrária, fixa) do advisory lock que serializa a abertura de alertas: sem ele, o worker e a API poderiam
 * ler "não há alerta aberto" ao mesmo tempo e abrir dois.
 */
export const ALERTS_WRITE_LOCK = 7461010;

/** Os tipos que não se referem a uma mensagem: um aberto por tipo. */
const MAILBOX_KINDS: AlertKind[] = ['mailbox_error', 'backfill_summary', 'budget_waiting'];

/** Tentativas de mandar um aviso ao celular antes de desistir (o alerta do app fica). */
const PHONE_MAX_ATTEMPTS = 3;

const isOpen = and(isNull(alerts.resolvedAt), isNull(alerts.dismissedAt));

export interface NewAlert {
  kind: AlertKind;
  jobId?: number | null;
  mailMessageId?: number | null;
  replyId?: number | null;
  payload?: AlertPayload;
}

/**
 * Abre um alerta. Um aberto por (kind, mensagem); os tipos sem mensagem (`mailbox_error`, `backfill_summary`,
 * `budget_waiting`) têm um aberto por tipo, e uma nova chamada só atualiza o payload. Devolve o id, ou null se já havia.
 */
export async function raiseAlert(db: Db, input: NewAlert, now: number = Date.now()): Promise<number | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(ALERTS_WRITE_LOCK))})`);
    const mailboxLevel = MAILBOX_KINDS.includes(input.kind);
    const messageId = input.mailMessageId ?? null;
    const same = mailboxLevel
      ? eq(alerts.kind, input.kind)
      : and(eq(alerts.kind, input.kind), messageId === null ? isNull(alerts.mailMessageId) : eq(alerts.mailMessageId, messageId));
    const [open] = await tx.select({ id: alerts.id }).from(alerts).where(and(same, isOpen)).limit(1);
    if (open) {
      if (mailboxLevel) await tx.update(alerts).set({ payload: input.payload ?? {} }).where(eq(alerts.id, open.id));
      return null;
    }
    const [row] = await tx
      .insert(alerts)
      .values({
        kind: input.kind, jobId: input.jobId ?? null, mailMessageId: messageId, replyId: input.replyId ?? null, payload: input.payload ?? {},
        createdAt: now,
      })
      .returning({ id: alerts.id });
    return row.id;
  });
}

/**
 * A mensagem e a vaga de um alerta, para consultas que juntam `mail_replies` e `mail_messages`. Um alerta de rascunho
 * pode apontar só para a resposta: a mensagem vem dela, e a vaga vem da mensagem quando o alerta não a tem.
 */
const alertLinks = () => ({
  messageId: sql<number | null>`coalesce(${alerts.mailMessageId}, ${mailReplies.messageId})`,
  jobId: sql<number | null>`coalesce(${alerts.jobId}, ${mailMessages.jobId})`,
});

/** Alertas com o card e o e-mail. */
function selectAlertDtos(db: Db, where: SQL | undefined) {
  const { messageId, jobId } = alertLinks();
  return db
    .select({
      id: alerts.id, kind: alerts.kind, jobId: jobId.mapWith(Number), company: jobs.company, jobTitle: jobs.title,
      messageId: messageId.mapWith(Number), replyId: alerts.replyId, subject: mailMessages.subject, summary: mailMessages.summary,
      payload: alerts.payload, createdAt: alerts.createdAt,
    })
    .from(alerts)
    .leftJoin(mailReplies, eq(mailReplies.id, alerts.replyId))
    .leftJoin(mailMessages, eq(mailMessages.id, messageId))
    .leftJoin(jobs, eq(jobs.id, jobId))
    .where(where);
}

/** Abertos (sem `resolvedAt` nem `dismissedAt`), do mais novo ao mais antigo, com empresa, título, assunto e resumo. */
export async function openAlerts(db: Db): Promise<AlertDto[]> {
  return selectAlertDtos(db, isOpen).orderBy(desc(alerts.createdAt), desc(alerts.id));
}

export async function alertById(db: Db, id: number): Promise<AlertRow | null> {
  const [row] = await db.select().from(alerts).where(eq(alerts.id, id));
  return row ?? null;
}

/** Resolve os alertas abertos que batem com TODOS os filtros dados. Sem filtro, não resolve nada. Devolve quantos. */
export async function resolveAlerts(
  db: Db, where: { kind?: AlertKind; mailMessageId?: number; replyId?: number }, now: number = Date.now(),
): Promise<number> {
  const filters: SQL[] = [];
  if (where.kind !== undefined) filters.push(eq(alerts.kind, where.kind));
  if (where.mailMessageId !== undefined) filters.push(eq(alerts.mailMessageId, where.mailMessageId));
  if (where.replyId !== undefined) filters.push(eq(alerts.replyId, where.replyId));
  if (filters.length === 0) return 0;
  const rows = await db
    .update(alerts)
    .set({ resolvedAt: now })
    .where(and(isOpen, ...filters))
    .returning({ id: alerts.id });
  return rows.length;
}

/** O dono dispensou o alerta. Devolve false se ele não estava aberto. */
export async function dismissAlert(db: Db, id: number, now: number = Date.now()): Promise<boolean> {
  const rows = await db
    .update(alerts)
    .set({ dismissedAt: now })
    .where(and(eq(alerts.id, id), isOpen))
    .returning({ id: alerts.id });
  return rows.length > 0;
}

/** Alerta `interview` ou `offer` aberto, sem aviso no celular enviado e com menos de 3 tentativas; o mais antigo. */
export async function nextPhoneAlert(db: Db): Promise<AlertDto | null> {
  const [row] = await selectAlertDtos(
    db,
    and(isOpen, inArray(alerts.kind, ['interview', 'offer']), isNull(alerts.phoneSentAt), lt(alerts.phoneAttempts, PHONE_MAX_ATTEMPTS)),
  )
    .orderBy(asc(alerts.createdAt), asc(alerts.id))
    .limit(1);
  return row ?? null;
}

/** Conta uma tentativa de aviso no celular; com `sent`, grava a hora do envio. */
export async function markPhoneAttempt(db: Db, id: number, sent: boolean, now: number = Date.now()): Promise<void> {
  await db
    .update(alerts)
    .set({ phoneAttempts: sql`${alerts.phoneAttempts} + 1`, ...(sent ? { phoneSentAt: now } : {}) })
    .where(eq(alerts.id, id));
}

const BADGE_PRIORITY: Exclude<JobMailMarks['badge'], null>[] = ['entrevista', 'oferta', 'pedido'];

/**
 * Por vaga: `confirmed` (há e-mail `recebimento`) e `badge` (alerta aberto: `interview` -> 'entrevista', `offer` ->
 * 'oferta', `missing_fact` ou `draft` de um pedido -> 'pedido'; nessa ordem de prioridade). Só as vagas com alguma marca.
 */
export async function mailMarksForJobs(db: Db): Promise<Map<number, JobMailMarks>> {
  const marks = new Map<number, JobMailMarks>();
  const confirmed = await db
    .selectDistinct({ jobId: mailMessages.jobId })
    .from(mailMessages)
    .where(eq(mailMessages.kind, 'recebimento'));
  for (const { jobId } of confirmed) if (jobId !== null) marks.set(jobId, { confirmed: true, badge: null });

  const { messageId, jobId } = alertLinks();
  const open = await db
    .select({ kind: alerts.kind, jobId: jobId.mapWith(Number), messageKind: mailMessages.kind })
    .from(alerts)
    .leftJoin(mailReplies, eq(mailReplies.id, alerts.replyId))
    .leftJoin(mailMessages, eq(mailMessages.id, messageId))
    .where(and(isOpen, inArray(alerts.kind, ['interview', 'offer', 'missing_fact', 'draft'])));
  for (const alert of open) {
    if (alert.jobId === null) continue;
    const badge =
      alert.kind === 'interview' ? 'entrevista'
      : alert.kind === 'offer' ? 'oferta'
      : alert.kind === 'missing_fact' || alert.messageKind === 'pedido' ? 'pedido'
      : null;
    if (badge === null) continue;
    const current = marks.get(alert.jobId) ?? { confirmed: false, badge: null };
    if (current.badge === null || BADGE_PRIORITY.indexOf(badge) < BADGE_PRIORITY.indexOf(current.badge)) current.badge = badge;
    marks.set(alert.jobId, current);
  }
  return marks;
}
