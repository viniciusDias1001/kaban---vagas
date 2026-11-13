import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { EmailKind, EmailLang, EmailRequest, MailIgnoredDto } from '@kv/shared';
import { COLUMNS, isAppliedOrLater } from '@kv/shared';
import type { Db } from './client';
import { applications, jobEvents, jobs, mailAccount, mailIgnored, mailMessages } from './schema';

export type MailAccountRow = typeof mailAccount.$inferSelect;
export type MailMessageRow = typeof mailMessages.$inferSelect;
export type MailIgnoredRow = typeof mailIgnored.$inferSelect;

const ACCOUNT_ID = 1;

export async function getMailAccount(db: Db): Promise<MailAccountRow | null> {
  const [row] = await db.select().from(mailAccount).where(eq(mailAccount.id, ACCOUNT_ID));
  return row ?? null;
}

/** Conecta (ou reconecta): grava a linha 1 com cursor zerado, `connectedAt = now`, sem erro nem pausa, `backfillDone` false. */
export async function saveMailAccount(db: Db, address: string, now: number = Date.now()): Promise<void> {
  const fresh = {
    address, connectedAt: now, uidValidity: null, lastUid: null, lastReadAt: null, backfillDone: false, paused: false, error: null,
  };
  await db
    .insert(mailAccount)
    .values({ id: ACCOUNT_ID, ...fresh })
    .onConflictDoUpdate({ target: mailAccount.id, set: fresh });
}

export async function updateMailAccount(db: Db, patch: Partial<Omit<MailAccountRow, 'id'>>): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db.update(mailAccount).set(patch).where(eq(mailAccount.id, ACCOUNT_ID));
}

export async function deleteMailAccount(db: Db): Promise<void> {
  await db.delete(mailAccount).where(eq(mailAccount.id, ACCOUNT_ID));
}

export interface NewMailMessage {
  messageId: string; threadKey: string; direction: 'in' | 'out'; uid: number | null; fromAddress: string; fromName: string;
  toAddress: string; replyTo: string | null; subject: string; sentAt: number; body: string; inReplyTo: string | null;
  refs: string[]; autoSubmitted: boolean; listId: boolean; backfill: boolean; jobId?: number | null; linkedBy?: 'auto' | 'owner' | null;
  /** Mensagem que não precisa de classificação nem de ação (as do dono e as enviadas pelo app): grava `processedAt = now`. */
  settled?: boolean;
}

/** Insere; devolve null se o Message-ID já existe (em mensagens ou em ignorados). */
export async function insertMailMessage(db: Db, input: NewMailMessage, now: number = Date.now()): Promise<number | null> {
  const { settled, jobId, linkedBy, ...rest } = input;
  return db.transaction(async (tx) => {
    const [ignored] = await tx.select({ id: mailIgnored.id }).from(mailIgnored).where(eq(mailIgnored.messageId, input.messageId));
    if (ignored) return null;
    const [row] = await tx
      .insert(mailMessages)
      .values({ ...rest, jobId: jobId ?? null, linkedBy: linkedBy ?? null, processedAt: settled ? now : null, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: mailMessages.id });
    return row?.id ?? null;
  });
}

/** Dos ids dados, quais já são conhecidos (mensagens ou ignorados). */
export async function knownMessageIds(db: Db, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const [stored, ignored] = await Promise.all([
    db.select({ id: mailMessages.messageId }).from(mailMessages).where(inArray(mailMessages.messageId, messageIds)),
    db.select({ id: mailIgnored.messageId }).from(mailIgnored).where(inArray(mailIgnored.messageId, messageIds)),
  ]);
  return new Set([...stored, ...ignored].map((r) => r.id));
}

/**
 * Para cada fio conhecido entre os dados: a vaga a que o fio está ligado (null se a nenhuma). A ligação do dono vence (a
 * mais recente, que pode ser "sem vaga"); sem ela, vale a vaga mais recente gravada no fio.
 */
export async function threadJobs(db: Db, threadKeys: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (threadKeys.length === 0) return result;
  const rows = await db
    .select({ threadKey: mailMessages.threadKey, jobId: mailMessages.jobId, linkedBy: mailMessages.linkedBy })
    .from(mailMessages)
    .where(inArray(mailMessages.threadKey, threadKeys))
    .orderBy(asc(mailMessages.id));
  const byOwner = new Set<string>();
  for (const r of rows) {
    if (r.linkedBy === 'owner') {
      result.set(r.threadKey, r.jobId);
      byOwner.add(r.threadKey);
    } else if (!byOwner.has(r.threadKey)) {
      result.set(r.threadKey, r.jobId ?? result.get(r.threadKey) ?? null);
    }
  }
  return result;
}

export interface MatchPoolItem { jobId: number; company: string; title: string; country: 'BR' | 'INT'; appliedAt: number }

const APPLIED_COLUMNS = COLUMNS.filter((c) => isAppliedOrLater(c));

/**
 * Cards em Aplicada ou depois, e vagas com candidatura `submitted`. `appliedAt`: `applications.submitted_at`; sem ela, o
 * primeiro evento do card para 'aplicada'; sem ele, o evento mais recente do card.
 */
export async function mailMatchPool(db: Db): Promise<MatchPoolItem[]> {
  const rows = await db
    .select({
      jobId: jobs.id, company: jobs.company, title: jobs.title, country: jobs.country, discoveredAt: jobs.discoveredAt,
      submittedAt: applications.submittedAt,
    })
    .from(jobs)
    .leftJoin(applications, eq(applications.jobId, jobs.id))
    .where(or(inArray(jobs.column, APPLIED_COLUMNS), eq(applications.status, 'submitted')))
    .orderBy(asc(jobs.id));
  if (rows.length === 0) return [];
  const events = await db
    .select({ jobId: jobEvents.jobId, toColumn: jobEvents.toColumn, createdAt: jobEvents.createdAt })
    .from(jobEvents)
    .where(inArray(jobEvents.jobId, rows.map((r) => r.jobId)));
  const firstApplied = new Map<number, number>();
  const latest = new Map<number, number>();
  for (const e of events) {
    if (e.toColumn === 'aplicada' && e.createdAt < (firstApplied.get(e.jobId) ?? Infinity)) firstApplied.set(e.jobId, e.createdAt);
    if (e.createdAt > (latest.get(e.jobId) ?? -Infinity)) latest.set(e.jobId, e.createdAt);
  }
  return rows.map((r) => ({
    jobId: r.jobId, company: r.company, title: r.title, country: r.country as 'BR' | 'INT',
    appliedAt: r.submittedAt ?? firstApplied.get(r.jobId) ?? latest.get(r.jobId) ?? r.discoveredAt,
  }));
}

/** A mensagem recebida mais antiga sem tipo. Com `onlyForced`, só as de `forceClassify`. */
export async function nextUnclassified(db: Db, opts: { onlyForced?: boolean } = {}): Promise<MailMessageRow | null> {
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(and(unclassified(), opts.onlyForced ? eq(mailMessages.forceClassify, true) : undefined))
    .orderBy(asc(mailMessages.sentAt), asc(mailMessages.id))
    .limit(1);
  return row ?? null;
}

/** Recebida, sem tipo e sem acerto de contas (as do dono e as do app já nascem com `processedAt`). */
const unclassified = () =>
  and(eq(mailMessages.direction, 'in'), isNull(mailMessages.kind), isNull(mailMessages.processedAt));

export async function countUnclassified(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(mailMessages).where(unclassified());
  return Number(row.n);
}

/**
 * Grava a classificação. Se o fio já foi ligado pelo dono (`linkedBy = 'owner'` em alguma mensagem), a vaga do fio fica
 * (a mensagem a recebe); senão grava `jobId` com `linkedBy = 'auto'` quando há vaga, e deixa os dois nulos quando não há.
 */
export async function saveClassification(
  db: Db,
  id: number,
  c: { kind: EmailKind; summary: string; lang: EmailLang; requests: EmailRequest[]; jobId: number | null },
  now: number = Date.now(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [msg] = await tx.select({ threadKey: mailMessages.threadKey }).from(mailMessages).where(eq(mailMessages.id, id));
    if (!msg) return;
    const [owner] = await tx
      .select({ jobId: mailMessages.jobId })
      .from(mailMessages)
      .where(and(eq(mailMessages.threadKey, msg.threadKey), eq(mailMessages.linkedBy, 'owner')))
      .orderBy(desc(mailMessages.id))
      .limit(1);
    const link = owner
      ? { jobId: owner.jobId, linkedBy: 'owner' as const }
      : { jobId: c.jobId, linkedBy: c.jobId === null ? null : ('auto' as const) };
    await tx
      .update(mailMessages)
      .set({ kind: c.kind, summary: c.summary, lang: c.lang, requests: c.requests, classifiedAt: now, forceClassify: false, ...link })
      .where(eq(mailMessages.id, id));
  });
}

/** A mensagem recebida mais antiga (pela data do e-mail) com tipo e sem `processedAt`. */
export async function nextUnprocessed(db: Db): Promise<MailMessageRow | null> {
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(and(eq(mailMessages.direction, 'in'), isNotNull(mailMessages.kind), isNull(mailMessages.processedAt)))
    .orderBy(asc(mailMessages.sentAt), asc(mailMessages.id))
    .limit(1);
  return row ?? null;
}

/** Grava `processedAt` (`db` pode ser a transação da ação). */
export async function markProcessed(db: Db, id: number, now: number = Date.now()): Promise<void> {
  await db.update(mailMessages).set({ processedAt: now }).where(eq(mailMessages.id, id));
}

/** Zera `processedAt`: a mensagem volta a esperar ação. Devolve false se ela não existe. */
export async function reopenMessage(db: Db, id: number): Promise<boolean> {
  const rows = await db.update(mailMessages).set({ processedAt: null }).where(eq(mailMessages.id, id)).returning({ id: mailMessages.id });
  return rows.length > 0;
}

/** Liga `forceClassify` nas mensagens que esperam tipo (as presas pelo limite diário). Devolve quantas. */
export async function forceClassifyAll(db: Db): Promise<number> {
  const rows = await db
    .update(mailMessages)
    .set({ forceClassify: true })
    .where(and(unclassified(), eq(mailMessages.forceClassify, false)))
    .returning({ id: mailMessages.id });
  return rows.length;
}

/** O dono ligou a mensagem a um card: o fio inteiro passa a ser dele (`linkedBy = 'owner'`) e a mensagem volta a esperar ação. */
export async function linkThreadToJob(db: Db, messageId: number, jobId: number, _now: number = Date.now()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [msg] = await tx.select({ threadKey: mailMessages.threadKey }).from(mailMessages).where(eq(mailMessages.id, messageId));
    if (!msg) return false;
    await tx.update(mailMessages).set({ jobId, linkedBy: 'owner' }).where(eq(mailMessages.threadKey, msg.threadKey));
    await tx.update(mailMessages).set({ processedAt: null }).where(eq(mailMessages.id, messageId));
    return true;
  });
}

/** "Não é desta vaga": o fio fica sem vaga, `linkedBy = 'owner'`, `corrected = true`. */
export async function unlinkThread(db: Db, messageId: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [msg] = await tx.select({ threadKey: mailMessages.threadKey }).from(mailMessages).where(eq(mailMessages.id, messageId));
    if (!msg) return false;
    await tx.update(mailMessages).set({ jobId: null, linkedBy: 'owner', corrected: true }).where(eq(mailMessages.threadKey, msg.threadKey));
    return true;
  });
}

export async function mailMessageById(db: Db, id: number): Promise<MailMessageRow | null> {
  const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, id));
  return row ?? null;
}

/** Mais antiga primeiro. */
export async function threadMessages(db: Db, threadKey: string): Promise<MailMessageRow[]> {
  return db.select().from(mailMessages).where(eq(mailMessages.threadKey, threadKey)).orderBy(asc(mailMessages.sentAt), asc(mailMessages.id));
}

export interface NewIgnored { messageId: string; uid: number; fromAddress: string; fromName: string; subject: string; sentAt: number; company: string }

/** Sem erro se já existe. */
export async function insertIgnored(db: Db, input: NewIgnored, now: number = Date.now()): Promise<void> {
  await db.insert(mailIgnored).values({ ...input, createdAt: now }).onConflictDoNothing();
}

/** Mais novas primeiro (pela data do e-mail). */
export async function listIgnored(db: Db): Promise<MailIgnoredDto[]> {
  return db
    .select({
      id: mailIgnored.id, fromAddress: mailIgnored.fromAddress, fromName: mailIgnored.fromName, subject: mailIgnored.subject,
      sentAt: mailIgnored.sentAt, company: mailIgnored.company, promoted: mailIgnored.promote,
    })
    .from(mailIgnored)
    .orderBy(desc(mailIgnored.sentAt), desc(mailIgnored.id));
}

export async function requestPromote(db: Db, id: number): Promise<boolean> {
  const rows = await db.update(mailIgnored).set({ promote: true }).where(eq(mailIgnored.id, id)).returning({ id: mailIgnored.id });
  return rows.length > 0;
}

/** O ignorado mais antigo que o dono pediu para guardar. */
export async function nextPromoted(db: Db): Promise<MailIgnoredRow | null> {
  const [row] = await db
    .select()
    .from(mailIgnored)
    .where(eq(mailIgnored.promote, true))
    .orderBy(asc(mailIgnored.sentAt), asc(mailIgnored.id))
    .limit(1);
  return row ?? null;
}

export async function deleteIgnored(db: Db, id: number): Promise<void> {
  await db.delete(mailIgnored).where(eq(mailIgnored.id, id));
}

/** Apaga ignorados criados antes de `before`. */
export async function pruneIgnored(db: Db, before: number): Promise<number> {
  const rows = await db.delete(mailIgnored).where(lt(mailIgnored.createdAt, before)).returning({ id: mailIgnored.id });
  return rows.length;
}
