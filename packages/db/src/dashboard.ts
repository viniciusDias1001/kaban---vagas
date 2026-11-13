import { and, asc, count, desc, eq, exists, gte, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { ApplySiteId, Column, EmailKind, ResumeLang } from '@kv/shared';
import { EMAIL_KINDS } from '@kv/shared';
import type { Db } from './client';
import { applications, jobAi, jobEvents, jobs, mailMessages, mailReplies } from './schema';

/*
 * Leituras do Painel. Nenhum número é guardado: cada função lê o que o app já grava, num número fixo de consultas.
 * E-mail com `corrected = true` (classificação corrigida ou movimento desfeito) não conta em nada, nem o evento do
 * card que ele causou.
 */

export interface AppliedJobFact {
  jobId: number; source: string; column: Column; appliedBy: 'ia' | 'humano';
  /** `applications.site` da candidatura enviada; null se aplicada por fora do app. */
  site: ApplySiteId | null;
  score: number | null; resumeLang: ResumeLang | null;
  appliedAt: number;
  /** O mais cedo entre: primeiro e-mail recebido ligado à vaga, com tipo que não seja `recebimento` e não corrigido; primeiro evento para entrevista, oferta ou perdida. */
  firstResponseAt: number | null;
  /** Primeiro evento para `entrevista`. */ interviewAt: number | null;
  /** Primeiro evento para `oferta`. */ offerAt: number | null;
  /** Evento mais recente para `perdida`, só se o card está em `perdida` agora. */ lostAt: number | null;
}

/** Colunas que dizem que a vaga foi aplicada; as três últimas dizem também que a empresa respondeu. */
const APPLIED_COLUMNS: Column[] = ['aplicada', 'entrevista', 'oferta', 'perdida'];
const ANSWERED_COLUMNS: Column[] = ['entrevista', 'oferta', 'perdida'];

/** Evento do card que não veio de um e-mail corrigido (o join com `mail_messages` é feito por quem usa). */
const eventCounts = or(isNull(jobEvents.mailMessageId), eq(mailMessages.corrected, false));

const firstEvent = (where: SQL) => sql<number | null>`min(${jobEvents.createdAt}) filter (where ${where})`.mapWith(jobEvents.createdAt);

/**
 * Uma linha por vaga aplicada (candidatura `submitted`, ou evento para aplicada, entrevista, oferta ou perdida) com
 * `appliedAt >= since` (todas com `since` null), da mais antiga para a mais nova. Três consultas, qualquer que seja o
 * número de vagas: as etapas agregadas por vaga, o primeiro e-mail de resposta por vaga e os dados das vagas.
 */
export async function appliedJobFacts(db: Db, since: number | null): Promise<AppliedJobFact[]> {
  const stageRows = await db
    .select({
      jobId: jobEvents.jobId,
      appliedAt: firstEvent(inArray(jobEvents.toColumn, APPLIED_COLUMNS)),
      answeredAt: firstEvent(inArray(jobEvents.toColumn, ANSWERED_COLUMNS)),
      interviewAt: firstEvent(eq(jobEvents.toColumn, 'entrevista')),
      offerAt: firstEvent(eq(jobEvents.toColumn, 'oferta')),
      lostAt: sql<number | null>`max(${jobEvents.createdAt}) filter (where ${eq(jobEvents.toColumn, 'perdida')})`.mapWith(jobEvents.createdAt),
    })
    .from(jobEvents)
    .leftJoin(mailMessages, eq(mailMessages.id, jobEvents.mailMessageId))
    .where(and(inArray(jobEvents.toColumn, APPLIED_COLUMNS), eventCounts))
    .groupBy(jobEvents.jobId);
  const stages = new Map(stageRows.map((r) => [r.jobId, r]));

  const answerRows = await db
    .select({ jobId: mailMessages.jobId, at: sql<number>`min(${mailMessages.sentAt})`.mapWith(mailMessages.sentAt) })
    .from(mailMessages)
    .where(
      and(
        isNotNull(mailMessages.jobId), eq(mailMessages.direction, 'in'), eq(mailMessages.corrected, false),
        isNotNull(mailMessages.kind), ne(mailMessages.kind, 'recebimento'),
      ),
    )
    .groupBy(mailMessages.jobId);
  const answers = new Map(answerRows.map((r) => [r.jobId!, r.at]));

  // A candidatura só entra pelo join quando foi enviada: ensaio, falha ou fila não fazem a vaga ser "aplicada".
  const jobRows = await db
    .select({
      jobId: jobs.id, source: jobs.source, column: jobs.column, appliedBy: jobs.appliedBy, score: jobAi.score,
      site: applications.site, resumeLang: applications.resumeLang, submittedAt: applications.submittedAt,
    })
    .from(jobs)
    .leftJoin(applications, and(eq(applications.jobId, jobs.id), eq(applications.status, 'submitted')))
    .leftJoin(jobAi, eq(jobAi.jobId, jobs.id))
    .where(
      or(
        isNotNull(applications.id),
        exists(
          db.select({ one: sql`1` }).from(jobEvents).where(and(eq(jobEvents.jobId, jobs.id), inArray(jobEvents.toColumn, APPLIED_COLUMNS))),
        ),
      ),
    );

  const facts: AppliedJobFact[] = [];
  for (const j of jobRows) {
    const s = stages.get(j.jobId);
    // Sem envio e com o único evento vindo de um e-mail corrigido, a vaga nunca foi aplicada.
    const appliedAt = j.submittedAt ?? s?.appliedAt ?? null;
    if (appliedAt === null || (since !== null && appliedAt < since)) continue;
    facts.push({
      jobId: j.jobId, source: j.source, column: j.column, appliedBy: j.appliedBy ?? 'humano',
      site: j.site, score: j.score, resumeLang: j.resumeLang, appliedAt,
      firstResponseAt: earliest(answers.get(j.jobId) ?? null, s?.answeredAt ?? null),
      interviewAt: s?.interviewAt ?? null,
      offerAt: s?.offerAt ?? null,
      lostAt: j.column === 'perdida' ? (s?.lostAt ?? null) : null,
    });
  }
  return facts.sort((a, b) => a.appliedAt - b.appliedAt || a.jobId - b.jobId);
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Candidaturas criadas desde `since` em `needs_human` ou `skipped`, por motivo, da mais frequente para a menos. */
export async function applyBlockers(
  db: Db,
  since: number | null,
): Promise<{ kind: 'needs_human' | 'skipped'; reason: string; count: number }[]> {
  const n = count();
  const rows = await db
    .select({ status: applications.status, reason: applications.reason, count: n })
    .from(applications)
    .where(
      and(
        inArray(applications.status, ['needs_human', 'skipped']),
        // Toda transição para estes dois estados grava o motivo; o filtro só mantém o tipo honesto.
        isNotNull(applications.reason),
        since === null ? undefined : gte(applications.createdAt, since),
      ),
    )
    .groupBy(applications.status, applications.reason)
    .orderBy(desc(n), asc(applications.status), asc(applications.reason));
  return rows.map((r) => ({ kind: r.status as 'needs_human' | 'skipped', reason: r.reason!, count: r.count }));
}

export interface MailFacts {
  /** Recebidas não corrigidas com `sentAt >= since`, por tipo; `waiting` = as ainda sem tipo. */
  received: Record<EmailKind, number>; waiting: number;
  repliedAuto: number; repliedApproved: number; discarded: number;
  /** Minutos entre o e-mail de origem e o envio, de cada resposta enviada, em ordem crescente. */
  replyMinutes: number[];
}

/**
 * E-mails recebidos e respostas do período. Uma resposta pertence ao período do e-mail que ela responde
 * (`mail_messages.sent_at >= since`), e não conta se esse e-mail foi corrigido. Duas consultas.
 */
export async function mailFacts(db: Db, since: number | null): Promise<MailFacts> {
  const inPeriod = and(
    eq(mailMessages.direction, 'in'), eq(mailMessages.corrected, false),
    since === null ? undefined : gte(mailMessages.sentAt, since),
  );

  const kindRows = await db
    .select({ kind: mailMessages.kind, count: count() })
    .from(mailMessages)
    .where(inPeriod)
    .groupBy(mailMessages.kind);
  const received = Object.fromEntries(EMAIL_KINDS.map((k) => [k, 0])) as Record<EmailKind, number>;
  let waiting = 0;
  for (const r of kindRows) {
    if (r.kind === null) waiting = r.count;
    else received[r.kind] = r.count;
  }

  const replyRows = await db
    .select({ state: mailReplies.state, approvedBy: mailReplies.approvedBy, sentAt: mailReplies.sentAt, originAt: mailMessages.sentAt })
    .from(mailReplies)
    .innerJoin(mailMessages, eq(mailMessages.id, mailReplies.messageId))
    .where(and(inPeriod, inArray(mailReplies.state, ['enviada', 'descartada'])));
  const facts: MailFacts = { received, waiting, repliedAuto: 0, repliedApproved: 0, discarded: 0, replyMinutes: [] };
  for (const r of replyRows) {
    if (r.state === 'descartada') {
      facts.discarded += 1;
      continue;
    }
    if (r.approvedBy === 'auto') facts.repliedAuto += 1;
    else if (r.approvedBy === 'owner') facts.repliedApproved += 1;
    if (r.sentAt !== null) facts.replyMinutes.push((r.sentAt - r.originAt) / 60_000);
  }
  facts.replyMinutes.sort((a, b) => a - b);
  return facts;
}
