import { and, asc, eq, inArray } from 'drizzle-orm';
import type { KnownFact, MailReplyDto, ReplyOrigin, ReplyState } from '@kv/shared';
import type { Db } from './client';
import { mailReplies } from './schema';

/*
 * Estados de uma resposta (no máximo uma por mensagem, pelo índice único de `message_id`):
 *   rascunho -> aprovada -> enviando -> enviada
 *                                   \-> falhou -> aprovada (de novo)
 *   rascunho | aprovada | falhou -> descartada
 *   aprovada | enviando -> rascunho (envio interrompido: volta a esperar o dono)
 * Cada passagem é um UPDATE condicionado ao estado de origem: de duas chamadas ao mesmo tempo, só uma passa. É isso que
 * garante uma resposta por pedido: `enviando` é gravado antes do envio e só sai dele por `markReplySent`,
 * `markReplyFailed` ou `returnReplyToDraft`, nunca de volta para `aprovada`.
 */

export type MailReplyRow = typeof mailReplies.$inferSelect;

export interface NewReply {
  messageId: number;
  origin: ReplyOrigin;
  items: KnownFact[];
  toAddress: string;
  subject: string;
  body: string;
  attachResume: boolean;
  state: 'rascunho' | 'aprovada';
  approvedBy?: 'auto' | 'owner' | null;
  note?: string | null;
}

/** Devolve null se a mensagem já tem resposta (em qualquer estado). */
export async function createReply(db: Db, input: NewReply, now: number = Date.now()): Promise<number | null> {
  const approved = input.state === 'aprovada';
  const [row] = await db
    .insert(mailReplies)
    .values({
      messageId: input.messageId, origin: input.origin, items: input.items, toAddress: input.toAddress, subject: input.subject,
      body: input.body, attachResume: input.attachResume, state: input.state, note: input.note ?? null, createdAt: now,
      approvedBy: approved ? (input.approvedBy ?? null) : null, approvedAt: approved ? now : null,
    })
    .onConflictDoNothing({ target: mailReplies.messageId })
    .returning({ id: mailReplies.id });
  return row?.id ?? null;
}

export async function replyById(db: Db, id: number): Promise<MailReplyRow | null> {
  const [row] = await db.select().from(mailReplies).where(eq(mailReplies.id, id));
  return row ?? null;
}

export async function replyForMessage(db: Db, messageId: number): Promise<MailReplyRow | null> {
  const [row] = await db.select().from(mailReplies).where(eq(mailReplies.messageId, messageId));
  return row ?? null;
}

/** Passa a resposta de um dos estados `from` para os valores dados, num só UPDATE. Devolve se passou. */
async function transition(db: Db, id: number, from: ReplyState[], set: Partial<typeof mailReplies.$inferInsert>): Promise<boolean> {
  const rows = await db
    .update(mailReplies)
    .set(set)
    .where(and(eq(mailReplies.id, id), inArray(mailReplies.state, from)))
    .returning({ id: mailReplies.id });
  return rows.length > 0;
}

/** Só em `rascunho`. */
export function editReply(db: Db, id: number, body: string): Promise<boolean> {
  return transition(db, id, ['rascunho'], { body });
}

/** `rascunho` ou `falhou` -> `aprovada`. */
export function approveReply(db: Db, id: number, by: 'auto' | 'owner', now: number = Date.now()): Promise<boolean> {
  return transition(db, id, ['rascunho', 'falhou'], { state: 'aprovada', approvedBy: by, approvedAt: now });
}

/** `rascunho`, `aprovada` ou `falhou` -> `descartada`, com a nota. A tabela não guarda a hora do descarte. */
export function discardReply(db: Db, id: number, note: string | null, _now: number = Date.now()): Promise<boolean> {
  return transition(db, id, ['rascunho', 'aprovada', 'falhou'], { state: 'descartada', note });
}

/** A resposta aprovada há mais tempo. */
export async function nextApprovedReply(db: Db): Promise<MailReplyRow | null> {
  const [row] = await db
    .select()
    .from(mailReplies)
    .where(eq(mailReplies.state, 'aprovada'))
    .orderBy(asc(mailReplies.approvedAt), asc(mailReplies.id))
    .limit(1);
  return row ?? null;
}

/**
 * `aprovada` -> `enviando`, gravando o Message-ID que vai sair. Devolve false se o estado já mudou. A tabela não guarda
 * a hora em que o envio começou: é pelo Message-ID que a mensagem é procurada em Enviados.
 */
export function markReplySending(db: Db, id: number, outMessageId: string, _now: number = Date.now()): Promise<boolean> {
  return transition(db, id, ['aprovada'], { state: 'enviando', outMessageId });
}

/** `enviando` -> `enviada`. */
export async function markReplySent(db: Db, id: number, now: number = Date.now()): Promise<void> {
  await transition(db, id, ['enviando'], { state: 'enviada', sentAt: now });
}

/** `enviando` -> `falhou`, com o motivo. A tabela não guarda a hora da falha. */
export async function markReplyFailed(db: Db, id: number, note: string, _now: number = Date.now()): Promise<void> {
  await transition(db, id, ['enviando'], { state: 'falhou', note });
}

/**
 * `aprovada` ou `enviando` -> `rascunho` com a nota (volta a esperar o dono). A aprovação é desfeita; o Message-ID de um
 * envio interrompido fica.
 */
export async function returnReplyToDraft(db: Db, id: number, note: string): Promise<void> {
  await transition(db, id, ['aprovada', 'enviando'], { state: 'rascunho', note, approvedBy: null, approvedAt: null });
}

/** As respostas paradas em `enviando` (o worker caiu no meio do envio). */
export function repliesInSending(db: Db): Promise<MailReplyRow[]> {
  return db.select().from(mailReplies).where(eq(mailReplies.state, 'enviando')).orderBy(asc(mailReplies.id));
}

export const toMailReplyDto = (r: MailReplyRow): MailReplyDto => ({
  id: r.id, messageId: r.messageId, origin: r.origin, items: r.items, toAddress: r.toAddress, subject: r.subject, body: r.body,
  attachResume: r.attachResume, state: r.state, note: r.note, createdAt: r.createdAt, sentAt: r.sentAt,
});
