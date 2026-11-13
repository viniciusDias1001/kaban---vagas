/**
 * Leitura da caixa: traz as mensagens novas da Caixa de entrada, passa cada uma no filtro local e guarda só as de vaga
 * (com o resto do fio). De quem só cita uma empresa do quadro fica uma linha sem texto em "ignorados". A caixa do dono
 * nunca muda: aqui só se lê.
 */
import {
  deleteIgnored, getMailAccount, insertIgnored, insertMailMessage, knownMessageIds, mailMatchPool, mailMessages, nextPromoted,
  pruneIgnored, raiseAlert, threadJobs, updateMailAccount, type Db, type MailAccountRow,
} from '@kv/db';
import { MailAuthError, MailTransientError, filterMail, type Mailbox, type RawMail } from '@kv/mail';
import { MAIL_LIMITS } from '@kv/shared';
import { and, eq } from 'drizzle-orm';

const DAY = 86_400_000;

export interface IngestDeps { db: Db; mailbox: Mailbox; now: () => number; log: (msg: string) => void }
export interface IngestResult { stored: number; ignored: number; more: boolean }

/**
 * Uma rodada de leitura: busca até MAIL_LIMITS.fetchBatch mensagens novas da Caixa de entrada, passa cada uma no filtro,
 * guarda as que passam (com o resto do fio) e a linha de ignorados das que só citam uma empresa do quadro; avança o
 * ponto de leitura; apaga ignorados com mais de 30 dias. `more` = veio um lote cheio (há mais para ler).
 */
export async function ingestInbox(deps: IngestDeps): Promise<IngestResult> {
  const { db, mailbox, now, log } = deps;
  const account = await getMailAccount(db);
  if (!account) return { stored: 0, ignored: 0, more: false };
  const since = account.connectedAt - MAIL_LIMITS.backfillDays * DAY;

  return withMailboxErrors(db, now, async () => {
    const batch = await mailbox.fetchInbox({
      uidValidity: account.uidValidity, afterUid: account.lastUid, since, limit: MAIL_LIMITS.fetchBatch,
    });
    const renumbered = account.uidValidity !== null && batch.uidValidity !== account.uidValidity;
    if (renumbered) log(`[mail] a caixa foi renumerada (UIDVALIDITY ${account.uidValidity} -> ${batch.uidValidity}); relendo desde o início`);

    // A busca por data do IMAP vale pelo dia inteiro: pode trazer um pouco mais que os 30 dias pedidos.
    const inWindow = batch.mails.filter((m) => m.date >= since);
    const known = await knownMessageIds(db, inWindow.map((m) => m.messageId));
    const fresh = inWindow.filter((m) => !known.has(m.messageId));
    const knownThreads = new Set((await threadJobs(db, [...new Set(fresh.map((m) => m.threadKey))])).keys());
    const companies = (await mailMatchPool(db)).map(({ company, title }) => ({ company, title }));
    const ctx = { ownAddress: account.address, knownThreads, companies };

    let stored = 0;
    let ignored = 0;
    // Mensagens que esta rodada já guardou (pelo fio de uma anterior do lote): não buscam o fio de novo.
    const storedNow = new Set<string>();
    for (const mail of fresh) {
      if (storedNow.has(mail.messageId)) continue;
      // Uma mensagem que não pode ser guardada não para a leitura: fica no log (só o UID) e a rodada segue. Erro da caixa
      // (login, rede, pasta escondida) sobe e para a rodada, como antes.
      try {
        const verdict = filterMail(mail, ctx);
        if (verdict.pass) {
          const thread = await mailbox.fetchThread(mail.threadKey);
          const ids = await storeJobThread(db, account, mail, thread, now());
          ids.forEach((id) => storedNow.add(id));
          stored += ids.length;
          knownThreads.add(mail.threadKey);
        } else if (verdict.ignoredCompany !== null) {
          // Só remetente, assunto e data: o texto de quem não passou no filtro nunca é guardado.
          await insertIgnored(db, {
            messageId: mail.messageId, uid: mail.uid, fromAddress: mail.from.address, fromName: mail.from.name,
            subject: mail.subject, sentAt: mail.date, company: verdict.ignoredCompany,
          }, now());
          ignored += 1;
        }
      } catch (e) {
        if (e instanceof MailAuthError || e instanceof MailTransientError) throw e;
        // Falha passageira do banco: a rodada para antes de o ponto de leitura andar, e a mensagem é lida de novo depois.
        if (isPassingDbError(e)) throw e;
        log(`[mail] a mensagem de UID ${mail.uid} não pôde ser guardada e foi pulada`);
      }
    }

    const lastUid = batch.mails.length > 0
      ? Math.max(...batch.mails.map((m) => m.uid))
      : renumbered ? null : account.lastUid;
    await updateMailAccount(db, { uidValidity: batch.uidValidity, lastUid, lastReadAt: now(), error: null });
    await pruneIgnored(db, now() - MAIL_LIMITS.ignoredDays * DAY);
    if (stored > 0 || ignored > 0) log(`[mail] ${stored} mensagem(ns) de vaga guardada(s), ${ignored} ignorada(s)`);
    return { stored, ignored, more: batch.mails.length === MAIL_LIMITS.fetchBatch };
  });
}

/** Trata um ignorado que o dono marcou "é de vaga": busca pelo UID, guarda como mensagem de vaga e apaga a linha. */
export async function promoteNext(deps: IngestDeps): Promise<boolean> {
  const { db, mailbox, now, log } = deps;
  const row = await nextPromoted(db);
  if (!row) return false;
  const account = await getMailAccount(db);
  if (!account) return false;

  return withMailboxErrors(db, now, async () => {
    const mail = await mailbox.fetchInboxByUid(row.uid);
    // Apagada da caixa, ou a caixa foi renumerada e o UID agora é de outra mensagem: não há o que guardar.
    if (!mail || mail.messageId !== row.messageId) {
      log(`[mail] o e-mail ignorado ${row.id} não está mais na Caixa de entrada; a linha foi apagada`);
      await deleteIgnored(db, row.id);
      return true;
    }
    const thread = await mailbox.fetchThread(mail.threadKey);
    await db.transaction(async (tx) => {
      // A linha sai antes: `insertMailMessage` recusa um Message-ID que ainda está em ignorados.
      await deleteIgnored(tx, row.id);
      await storeJobThread(tx, account, mail, thread, now());
    });
    return true;
  });
}

/** Códigos de conexão do driver do Postgres (sem SQLSTATE): a conexão caiu ou não abriu. */
const CONNECTION_CODES = new Set(['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']);

/**
 * Erro do banco que passa sozinho: SQLSTATE de conexão (08), de conflito de transação (40), de recurso (53), de operação
 * interrompida (57) ou de lock não obtido (55P03), ou a conexão do driver caída. O erro do Drizzle traz o do driver em `cause`.
 */
export function isPassingDbError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === 'object' && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code !== 'string') continue;
    if (CONNECTION_CODES.has(code) || code === '55P03' || /^(08|40|53|57)/.test(code)) return true;
  }
  return false;
}

/** Erro de login pausa a leitura, grava a causa e abre o alerta; erro passageiro só grava a causa. Relança os dois. */
export async function withMailboxErrors<T>(db: Db, now: () => number, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof MailAuthError) {
      await updateMailAccount(db, { paused: true, error: e.message });
      await raiseAlert(db, { kind: 'mailbox_error', payload: { reason: e.message } }, now());
    } else if (e instanceof MailTransientError) {
      await updateMailAccount(db, { error: e.message });
    }
    throw e;
  }
}

/**
 * Guarda a mensagem de vaga e as outras do fio que ainda não existem, numa transação, da mais antiga para a mais nova.
 * As do próprio dono entram como `out` e já acertadas; as outras como recebidas. Fio já ligado a um card: todas nascem
 * com essa vaga. Devolve os Message-IDs gravados.
 */
async function storeJobThread(db: Db, account: MailAccountRow, mail: RawMail, thread: RawMail[], now: number): Promise<string[]> {
  const members = thread.some((m) => m.messageId === mail.messageId) ? thread : [mail, ...thread];
  const own = account.address.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const link = await threadLink(tx, mail.threadKey);
    const stored: string[] = [];
    for (const m of members) {
      const isInbox = m.messageId === mail.messageId;
      const fromOwner = !isInbox && m.from.address.trim().toLowerCase() === own;
      const id = await insertMailMessage(tx, {
        messageId: m.messageId, threadKey: mail.threadKey, direction: fromOwner ? 'out' : 'in',
        // O UID do fio é de outra pasta (Todos os e-mails): só o da Caixa de entrada é guardado.
        uid: isInbox ? mail.uid : null,
        fromAddress: m.from.address, fromName: m.from.name, toAddress: m.to.join(', '), replyTo: m.replyTo,
        subject: m.subject, sentAt: m.date, body: m.text, inReplyTo: m.inReplyTo, refs: m.references,
        autoSubmitted: m.autoSubmitted, listId: m.listId, backfill: m.date < account.connectedAt,
        jobId: link.jobId, linkedBy: link.linkedBy, settled: fromOwner,
      }, now);
      if (id !== null) stored.push(m.messageId);
    }
    return stored;
  });
}

/** A vaga do fio (a do dono vence) e quem a ligou; fio desconhecido ou sem vaga: nulos. */
async function threadLink(db: Db, threadKey: string): Promise<{ jobId: number | null; linkedBy: 'auto' | 'owner' | null }> {
  const jobId = (await threadJobs(db, [threadKey])).get(threadKey) ?? null;
  const [byOwner] = await db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(and(eq(mailMessages.threadKey, threadKey), eq(mailMessages.linkedBy, 'owner')))
    .limit(1);
  if (byOwner) return { jobId, linkedBy: 'owner' };
  return { jobId, linkedBy: jobId === null ? null : 'auto' };
}
