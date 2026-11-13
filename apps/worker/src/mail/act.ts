/**
 * A ação sobre uma mensagem classificada: mover o card, abrir o alerta e preparar a resposta, segundo a tabela do spec.
 * As regras que tornam isso seguro são do código: o destinatário vem só dos cabeçalhos, a resposta sai sem aprovação só
 * quando tudo o que foi pedido é fato salvo e o endereço é confiável, e o que o modelo escreve é sempre rascunho.
 * Chamadas ao modelo acontecem antes da transação; tudo o que a ação grava vai numa transação só.
 */
import { draftEmailReply, verifyEmailDraft, type EmailDraftInput, type EmailForAi } from '@kv/ai';
import {
  JOBS_WRITE_LOCK, alerts as alertsTable, baseProfile, createReply, getMailAccount, jobs, listApplyAnswers, mailMessages, mailReplies, markProcessed, moveCardByEmail,
  moveStateFor, nextUnprocessed, raiseAlert, replyForMessage, threadMessages, updateMailAccount, type Db, type MailMessageRow, type NewReply,
} from '@kv/db';
import {
  chooseRecipient, composeFactsReply, decideMove, isTrustedRecipient, replySubject, resolveFact, type FactSources, type FactValue,
  type Recipient,
} from '@kv/mail';
import type {
  AlertKind, AlertPayload, CandidateProfile, DecisiveKind, EmailConfig, EmailKind, EmailLang, KnownFact,
} from '@kv/shared';
import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import type { MailWorkDeps } from './classify';

export const NO_REPLY_REASON = 'Este e-mail não aceita resposta.';
export const AMBIGUOUS_REPLY_REASON = 'Este e-mail pede resposta para mais de um endereço. Responda você mesmo.';
export const NO_DRAFT_REASON = 'Sem rascunho da IA. Responda você mesmo.';

interface JobInfo { id: number; company: string; title: string; country: 'BR' | 'INT' }

/** O que a ação vai gravar, decidido antes da transação (a regra do movimento é lida e aplicada dentro dela). */
interface Plan {
  job: JobInfo | null;
  /** O tipo que pode mover o card. */
  decisive: DecisiveKind | null;
  alert: { kind: AlertKind; payload: AlertPayload } | null;
  /** Um segundo alerta: o convite ou a oferta de um e-mail sem card, além do `unmatched`. */
  also?: { kind: AlertKind; payload: AlertPayload };
  reply: Omit<NewReply, 'messageId'> | null;
}

const NOTHING: Plan = { job: null, decisive: null, alert: null, reply: null };

/**
 * Abre o alerta de um e-mail, sabendo que ele pode já ter sido tratado antes (o dono o ligou ou religou a um card). Olha os
 * alertas do mesmo tipo desta mensagem (direto ou pela resposta dela):
 * - um ainda aberto (o convite sem card, por exemplo) recebe o card, a resposta e o motivo de agora, em vez de ficar velho;
 * - um já fechado para este mesmo card: nada (o mesmo e-mail no mesmo card nunca avisa duas vezes);
 * - só fechados, de outro card ou sem card: abre de novo para o card de agora, e se o celular já tocou por este e-mail, o
 *   novo nasce com o aviso dado (uma mensagem por convite ou oferta).
 * `missing_fact` fica de fora: "Tentar de novo" sem o valor salvo precisa avisar outra vez.
 */
async function raiseOnce(tx: Db, input: Parameters<typeof raiseAlert>[1], now: number): Promise<void> {
  if (input.kind === 'missing_fact' || !input.mailMessageId) {
    await raiseAlert(tx, input, now);
    return;
  }
  const jobId = input.jobId ?? null;
  const replyId = input.replyId ?? null;
  const earlier = await tx
    .select({
      id: alertsTable.id, jobId: alertsTable.jobId, resolvedAt: alertsTable.resolvedAt, dismissedAt: alertsTable.dismissedAt,
      phoneSentAt: alertsTable.phoneSentAt,
    })
    .from(alertsTable)
    .leftJoin(mailReplies, eq(mailReplies.id, alertsTable.replyId))
    .where(and(
      eq(alertsTable.kind, input.kind),
      or(eq(alertsTable.mailMessageId, input.mailMessageId), eq(mailReplies.messageId, input.mailMessageId)),
    ))
    .orderBy(desc(alertsTable.id));
  const open = earlier.find((a) => a.resolvedAt === null && a.dismissedAt === null);
  if (open) {
    await tx
      .update(alertsTable)
      .set({ jobId, replyId, mailMessageId: input.mailMessageId, payload: input.payload ?? {} })
      .where(eq(alertsTable.id, open.id));
    return;
  }
  if (earlier.some((a) => a.jobId === jobId)) return;
  const id = await raiseAlert(tx, input, now);
  const rang = earlier.find((a) => a.phoneSentAt !== null);
  if (id !== null && rang) await tx.update(alertsTable).set({ phoneSentAt: rang.phoneSentAt }).where(eq(alertsTable.id, id));
}

/** Age sobre a mensagem classificada mais antiga, numa transação. Devolve se havia o que fazer. */
export async function actOnNext(deps: MailWorkDeps): Promise<boolean> {
  const { db, settings, now } = deps;
  const mail = await nextUnprocessed(db);
  if (!mail) return false;
  const config = await settings.emailConfig();
  const plan = await prepare(deps, mail, config);
  await db.transaction(async (tx) => {
    // Uma ordem de locks para todos: vagas (advisory e linha do card), depois a mensagem, depois os alertas.
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(JOBS_WRITE_LOCK))})`);
    if (plan.job) await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, plan.job.id)).for('update');
    const [row] = await tx
      .select({ processedAt: mailMessages.processedAt, kind: mailMessages.kind, jobId: mailMessages.jobId })
      .from(mailMessages)
      .where(eq(mailMessages.id, mail.id))
      .for('update');
    // Já tratada, ou o dono religou o fio (ou a classificação mudou) depois da leitura: a próxima rodada decide de novo.
    if (!row || row.processedAt !== null || row.kind !== mail.kind || row.jobId !== mail.jobId) return;
    await act(tx, mail, plan, config, now());
  });
  return true;
}

/** Grava a ação. Roda dentro da transação, depois dos locks de vagas e da mensagem. */
async function act(tx: Db, mail: MailMessageRow, plan: Plan, config: EmailConfig, now: number): Promise<void> {
  const { job } = plan;
  if (job && plan.decisive) {
    // Lido depois do lock: um movimento do dono não passa entre a leitura e o movimento.
    const state = await moveStateFor(tx, job.id);
    const to = state ? decideMove(plan.decisive, mail.sentAt, state) : null;
    if (to !== null && config.moveMode === 'auto') await moveCardByEmail(tx, { jobId: job.id, to, messageId: mail.id }, now);
    if (to !== null && config.moveMode === 'confirm') {
      await raiseOnce(tx, { kind: 'move_confirm', jobId: job.id, mailMessageId: mail.id, payload: { moveTo: to } }, now);
    }
  }
  // Uma resposta por mensagem: agindo de novo (e-mail religado), o alerta aponta para a que já existe.
  const replyId = plan.reply
    ? (await createReply(tx, { ...plan.reply, messageId: mail.id }, now)) ?? (await replyForMessage(tx, mail.id))?.id ?? null
    : null;
  for (const alert of [plan.alert, plan.also]) {
    if (!alert) continue;
    await raiseOnce(tx, { kind: alert.kind, jobId: job?.id ?? null, mailMessageId: mail.id, replyId, payload: alert.payload }, now);
  }
  await markProcessed(tx, mail.id, now);
}

const isDecisive = (kind: EmailKind): kind is DecisiveKind => kind === 'reprovacao' || kind === 'entrevista' || kind === 'oferta';

/** A tabela do spec, com as leituras e as chamadas ao modelo de que ela precisa. */
async function prepare(deps: MailWorkDeps, mail: MailMessageRow, config: EmailConfig): Promise<Plan> {
  const { db } = deps;
  // Um pedido sem nada pedido não tem o que responder: é tratado como `outro`.
  const kind: EmailKind = mail.kind === 'pedido' && mail.requests.length === 0 ? 'outro' : mail.kind!;
  if (kind === 'recebimento' || kind === 'outro') return NOTHING;
  const job = mail.jobId === null ? null : await jobInfo(db, mail.jobId);
  const recipient = chooseRecipient({
    from: { address: mail.fromAddress, name: mail.fromName }, replyTo: mail.replyTo, autoSubmitted: mail.autoSubmitted, listId: mail.listId,
  });
  const noReply: AlertPayload = recipient.ok ? {} : { reason: reasonFor(recipient) };
  // Alerta `draft` ou `interview` sem resposta: sempre com o motivo (não aceita resposta, endereço ambíguo, ou sem rascunho).
  const withoutReply: AlertPayload = recipient.ok ? { reason: NO_DRAFT_REASON } : noReply;
  if (!job) {
    if (mail.backfill) return NOTHING;
    // Convite ou oferta sem card: além de pedir o card, avisa (no sino, no navegador e no celular, só com o tipo).
    const also = kind === 'entrevista' ? { kind: 'interview' as const, payload: withoutReply }
      : kind === 'oferta' ? { kind: 'offer' as const, payload: {} } : undefined;
    return { ...NOTHING, alert: { kind: 'unmatched', payload: {} }, ...(also ? { also } : {}) };
  }
  const decisive = isDecisive(kind) ? kind : null;
  // A primeira leitura só põe os cards onde estão: sem alerta, sem resposta.
  if (mail.backfill || kind === 'reprovacao') return { ...NOTHING, job, decisive };
  if (kind === 'oferta') return { ...NOTHING, job, decisive, alert: { kind: 'offer', payload: {} } };
  const profile = (await baseProfile(db))?.data ?? null;
  const lang: EmailLang = mail.lang ?? 'pt-BR';

  if (kind === 'entrevista') {
    const draft = recipient.ok && config.aiDrafts && profile
      ? await aiDraft(deps, mail, job, { profile, kind: 'entrevista', lang, requests: [] })
      : null;
    const reply = draft === null || !recipient.ok ? null : draftReply(mail, recipient.address, draft, []);
    return { job, decisive, alert: { kind: 'interview', payload: reply ? {} : withoutReply }, reply };
  }

  // Pedido. Sem perfil, nenhum fato pode ser respondido pelo código.
  const sources: FactSources | null = profile
    ? { profile, answers: await listApplyAnswers(db), country: job.country, hasResume: true }
    : null;
  const known = mail.requests.flatMap((r) =>
    r.fact === 'outro' ? [] : [{ fact: r.fact, value: sources ? resolveFact(r.fact, sources) : null }]);
  const saved = known.flatMap((k) => (k.value === null ? [] : [{ fact: k.fact, value: k.value }]));

  if (mail.requests.some((r) => r.fact === 'outro')) {
    const requests = mail.requests.map((r) => {
      const value = r.fact === 'outro' ? null : (known.find((k) => k.fact === r.fact)?.value ?? null);
      return { fact: r.fact, note: r.note, saved: value === null ? null : savedText(value, lang) };
    });
    const draft = recipient.ok && config.aiDrafts && profile
      ? await aiDraft(deps, mail, job, { profile, kind: 'pedido', lang, requests })
      : null;
    if (draft === null || !recipient.ok) return { ...NOTHING, job, alert: { kind: 'draft', payload: withoutReply } };
    return {
      ...NOTHING, job, alert: { kind: 'draft', payload: recipientNote(mail, recipient.address) },
      reply: draftReply(mail, recipient.address, draft, saved.map((s) => s.fact)),
    };
  }

  const missing = known.filter((k) => k.value === null).map((k) => k.fact);
  if (missing.length > 0) return { ...NOTHING, job, alert: { kind: 'missing_fact', payload: { missing, ...noReply } } };
  if (config.factsMode === 'off') return { ...NOTHING, job };
  if (!recipient.ok || !profile) return { ...NOTHING, job, alert: { kind: 'draft', payload: withoutReply } };

  const items = saved.map((s) => s.fact);
  const composed = composeFactsReply({ lang, name: profile.contact.name, subject: mail.subject, items: saved });
  const trusted = isTrustedRecipient(recipient.address, {
    sender: mail.fromAddress, company: job.company, threadAddresses: await earlierThreadAddresses(db, mail),
  });
  const auto = config.factsMode === 'auto' && trusted;
  return {
    ...NOTHING,
    job,
    reply: {
      origin: 'facts', items, toAddress: recipient.address, subject: composed.subject, body: composed.body,
      attachResume: items.includes('resume'), state: auto ? 'aprovada' : 'rascunho', approvedBy: auto ? 'auto' : null,
    },
    // Sem aprovação automática, o dono vê para quem a resposta iria quando não é quem mandou o e-mail.
    alert: auto ? null : { kind: 'draft', payload: recipientNote(mail, recipient.address) },
  };
}

/** O alerta só nomeia o destinatário quando a resposta não vai para quem mandou o e-mail. */
function recipientNote(mail: MailMessageRow, address: string): AlertPayload {
  const same = address.trim().toLowerCase() === mail.fromAddress.trim().toLowerCase();
  return same ? {} : { recipient: address };
}

function reasonFor(recipient: Extract<Recipient, { ok: false }>): string {
  return recipient.why === 'ambiguous' ? AMBIGUOUS_REPLY_REASON : NO_REPLY_REASON;
}

async function jobInfo(db: Db, jobId: number): Promise<JobInfo | null> {
  const [row] = await db
    .select({ id: jobs.id, company: jobs.company, title: jobs.title, country: jobs.country })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  return row ? { ...row, country: row.country as 'BR' | 'INT' } : null;
}

/**
 * Os endereços que já apareceram no fio antes desta mensagem: quem escreveu ao dono e para quem o dono (ou o app)
 * escreveu. O `Reply-To` de uma mensagem anterior não entra: é o campo que um e-mail forjado usaria.
 */
export async function earlierThreadAddresses(db: Db, mail: MailMessageRow): Promise<string[]> {
  const before = (await threadMessages(db, mail.threadKey)).filter(
    (m) => m.id !== mail.id && (m.sentAt < mail.sentAt || (m.sentAt === mail.sentAt && m.id < mail.id)),
  );
  return before.flatMap((m) => (m.direction === 'out' ? m.toAddress.split(',').map((a) => a.trim()).filter(Boolean) : [m.fromAddress]));
}

const asEmailForAi = (mail: MailMessageRow): EmailForAi => ({
  fromName: mail.fromName, fromAddress: mail.fromAddress, subject: mail.subject, date: mail.sentAt, text: mail.body,
});

/** O valor salvo como o rascunho o cita (e como a conferência o aceita). */
function savedText(value: FactValue, lang: EmailLang): string {
  const en = lang === 'en';
  if ('text' in value) return value.text;
  if ('flag' in value) return value.flag ? (en ? 'yes' : 'sim') : en ? 'no' : 'não';
  if ('amount' in value) {
    const n = String(Math.round(value.amount));
    if (value.unit === 'brl_month') return en ? `BRL ${n} per month` : `R$ ${n} por mês`;
    return en ? `USD ${n} per year` : `US$ ${n} por ano`;
  }
  return en ? 'résumé attached' : 'currículo em anexo';
}

function draftReply(mail: MailMessageRow, toAddress: string, body: string, items: KnownFact[]): Omit<NewReply, 'messageId'> {
  return {
    origin: 'ai', items, toAddress, subject: replySubject(mail.subject), body, attachResume: items.includes('resume'), state: 'rascunho',
  };
}

/**
 * Rascunho do modelo, conferido por `verifyEmailDraft`; com violações, uma segunda tentativa levando-as; ainda com
 * violações, nenhum. Sem IA, sem orçamento ou com o modelo falhando, também nenhum: o alerta sai do mesmo jeito.
 */
async function aiDraft(
  deps: MailWorkDeps, mail: MailMessageRow, job: JobInfo,
  input: { profile: CandidateProfile; kind: 'entrevista' | 'pedido'; lang: EmailLang; requests: EmailDraftInput['requests'] },
): Promise<string | null> {
  const { ai, log } = deps;
  const draftInput: EmailDraftInput = { ...input, mail: asEmailForAi(mail), company: job.company, jobTitle: job.title };
  try {
    if (!(await ai.configured())) return null;
    const write = async (violations?: string[]) =>
      (await ai.call('strong', (provider) => draftEmailReply(provider, { ...draftInput, violations }))).data;
    let text = await write();
    let violations = verifyEmailDraft(draftInput, text);
    if (violations.length === 0) return text;
    text = await write(violations);
    violations = verifyEmailDraft(draftInput, text);
    if (violations.length === 0) return text;
    log(`[mail] o rascunho para o e-mail ${mail.id} não passou na conferência: ${violations.join('; ')}`);
    return null;
  } catch (e) {
    log(`[mail] sem rascunho para o e-mail ${mail.id}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Depois da primeira leitura: sem mensagem `backfill` pendente, abre o alerta de resumo (se houve alguma) e grava `backfillDone`. */
export async function finishBackfill(deps: MailWorkDeps): Promise<boolean> {
  const { db, now } = deps;
  const account = await getMailAccount(db);
  // Antes da primeira leitura não há o que resumir: "nenhuma pendente" ainda não quer dizer "terminou".
  if (!account || account.backfillDone || account.lastReadAt === null) return false;
  // Só a primeira leitura desta conexão: as guardadas desde `connectedAt` (as de uma caixa anterior ficam de fora).
  const rows = await db
    .select({ kind: mailMessages.kind, processedAt: mailMessages.processedAt })
    .from(mailMessages)
    .where(and(
      eq(mailMessages.direction, 'in'), eq(mailMessages.backfill, true), gte(mailMessages.createdAt, account.connectedAt),
    ));
  if (rows.some((r) => r.processedAt === null)) return false;
  const counts: Partial<Record<EmailKind, number>> = {};
  let total = 0;
  for (const { kind } of rows) {
    if (kind === null) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
    total += 1;
  }
  await db.transaction(async (tx) => {
    if (total > 0) await raiseAlert(tx, { kind: 'backfill_summary', payload: { total, counts } }, now());
    await updateMailAccount(tx, { backfillDone: true });
  });
  return true;
}
