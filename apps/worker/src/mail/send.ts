/**
 * Envio das respostas aprovadas, uma de cada vez, e a recuperação de um envio interrompido. A promessa daqui é "uma
 * resposta por pedido": `enviando` é gravado antes do SMTP e nunca é refeito às cegas. Qualquer falha do envio é
 * conferida em Enviados pelo Message-ID: achou, a resposta saiu; não achou, falhou e o dono decide. Nada é tentado de
 * novo sozinho.
 */
import { randomUUID } from 'node:crypto';
import {
  applicationForJob, baseProfile, discardReply, getMailAccount, insertMailMessage, jobs, mailMessageById, markReplyFailed,
  markReplySending, markReplySent, nextApprovedReply, profileFor, raiseAlert, repliesInSending, resolveAlerts, returnReplyToDraft,
  type Db, type MailMessageRow, type MailReplyRow,
} from '@kv/db';
import type { Mailbox, OutgoingMail, RawMail } from '@kv/mail';
import { renderResumePdf } from '@kv/resume';
import type { EmailLang } from '@kv/shared';
import { eq } from 'drizzle-orm';
import { baseResume, resumeFileName } from '../apply/resume';
import { withMailboxErrors } from './ingest';

export interface SendDeps { db: Db; mailbox: Mailbox; now: () => number; log: (msg: string) => void;
  /** PDF a anexar: o da candidatura da vaga; sem ele, o currículo base no idioma da resposta. Null se não há perfil. */
  resume: (jobId: number | null, lang: EmailLang) => Promise<{ fileName: string; content: Buffer } | null>;
  /** Gera o Message-ID da resposta (sem os sinais de menor e maior). Trocado nos testes. */
  newMessageId?: () => string;
}

const ALREADY_ANSWERED = 'Você já respondeu este e-mail.';
const NO_RESUME = 'Não há currículo para anexar.';
const SEND_FAILED = 'O envio falhou. Tente de novo.';
const INTERRUPTED = 'O envio foi interrompido e o e-mail não está em Enviados. Confira e aprove de novo.';
/** Idioma de um e-mail que a IA ainda não classificou. */
const DEFAULT_LANG: EmailLang = 'pt-BR';
/** Empresa no nome do arquivo quando o e-mail não está ligado a um card. */
const NO_COMPANY = 'Empresa';

const defaultMessageId = (): string => `${randomUUID()}@kanban-vagas.local`;

/** Envia a resposta aprovada mais antiga. Devolve se havia o que fazer. */
export async function sendNext(deps: SendDeps): Promise<boolean> {
  const { db, mailbox, now, log } = deps;
  const account = await getMailAccount(db);
  if (!account) return false;
  const reply = await nextApprovedReply(db);
  if (!reply) return false;
  // A resposta é apagada junto com a mensagem (chave estrangeira em cascata): a origem sempre existe.
  const origin = (await mailMessageById(db, reply.messageId))!;

  const thread = await withMailboxErrors(db, now, () => mailbox.fetchThread(origin.threadKey));
  if (ownerAnswered(thread, account.address, origin.sentAt)) {
    if (await discardReply(db, reply.id, ALREADY_ANSWERED, now())) await resolveAlerts(db, { replyId: reply.id }, now());
    log(`[mail] resposta ${reply.id} descartada: o dono já respondeu no fio`);
    return true;
  }

  let attachment: OutgoingMail['attachment'] = null;
  if (reply.attachResume) {
    attachment = await deps.resume(origin.jobId, origin.lang ?? DEFAULT_LANG);
    if (!attachment) {
      await returnReplyToDraft(db, reply.id, NO_RESUME);
      await raiseAlert(db, { kind: 'draft', replyId: reply.id, payload: { reason: NO_RESUME } }, now());
      log(`[mail] resposta ${reply.id} voltou para rascunho: não há currículo para anexar`);
      return true;
    }
  }
  const mail: OutgoingMail = {
    messageId: (deps.newMessageId ?? defaultMessageId)(),
    from: account.address,
    fromName: await ownerName(db),
    // Só o destinatário escolhido quando a resposta foi criada: sem Cc nem Cco.
    to: reply.toAddress,
    subject: reply.subject,
    text: reply.body,
    inReplyTo: origin.messageId,
    references: referencesOf(origin),
    attachment,
  };

  if (!(await markReplySending(db, reply.id, mail.messageId, now()))) return true;
  try {
    await withMailboxErrors(db, now, () => mailbox.send(mail));
  } catch (e) {
    log(`[mail] o envio da resposta ${reply.id} deu erro (${(e as Error).message}); procurando em Enviados`);
    // Se a busca também falhar (a conexão caiu), a resposta fica em `enviando` e `recoverSending` a acerta no próximo início.
    const delivered = await withMailboxErrors(db, now, () => mailbox.sentExists(mail.messageId));
    if (!delivered) {
      await markReplyFailed(db, reply.id, SEND_FAILED, now());
      await raiseAlert(db, { kind: 'draft', replyId: reply.id, payload: { reason: SEND_FAILED } }, now());
      return true;
    }
  }
  await settleSent(db, reply, origin, mail, now());
  log(`[mail] resposta ${reply.id} enviada`);
  return true;
}

/**
 * No início do worker: para cada resposta em `enviando`, procura o Message-ID em Enviados: achou, `enviada`; não achou,
 * volta a `rascunho` com alerta `draft`. Devolve quantas tratou.
 */
export async function recoverSending(deps: SendDeps): Promise<{ sent: number; returned: number }> {
  const { db, mailbox, now, log } = deps;
  const account = await getMailAccount(db);
  const result = { sent: 0, returned: 0 };
  if (!account) return result;
  for (const reply of await repliesInSending(db)) {
    const outId = reply.outMessageId;
    const delivered = outId !== null && (await withMailboxErrors(db, now, () => mailbox.sentExists(outId)));
    if (delivered) {
      const origin = (await mailMessageById(db, reply.messageId))!;
      await settleSent(db, reply, origin, {
        messageId: outId, from: account.address, fromName: await ownerName(db), to: reply.toAddress, subject: reply.subject,
        text: reply.body, inReplyTo: origin.messageId, references: referencesOf(origin),
      }, now());
      result.sent += 1;
      log(`[mail] resposta ${reply.id} estava em Enviados: marcada como enviada`);
    } else {
      await returnReplyToDraft(db, reply.id, INTERRUPTED);
      await raiseAlert(db, { kind: 'draft', replyId: reply.id, payload: { reason: INTERRUPTED } }, now());
      result.returned += 1;
      log(`[mail] resposta ${reply.id} não está em Enviados: voltou para o dono aprovar`);
    }
  }
  return result;
}

/** O `resume` de produção. */
export function resumeForReply(db: Db): SendDeps['resume'] {
  return async (jobId, lang) => {
    let company = NO_COMPANY;
    if (jobId !== null) {
      const app = await applicationForJob(db, jobId);
      if (app?.resumePdf && app.resumeFileName) return { fileName: app.resumeFileName, content: app.resumePdf };
      const [job] = await db.select({ company: jobs.company }).from(jobs).where(eq(jobs.id, jobId));
      if (job?.company.trim()) company = job.company;
    }
    // O perfil no idioma da resposta; sem ele, o base, no idioma dele (um currículo nunca mistura dois idiomas).
    const profile = (await profileFor(db, lang)) ?? (await baseProfile(db));
    if (!profile) return null;
    const content = await renderResumePdf(baseResume(profile.data, profile.lang));
    return { fileName: resumeFileName(profile.lang, profile.data.contact.name, company), content };
  };
}

/** O dono escreveu no fio depois da mensagem a que a resposta responde. */
function ownerAnswered(thread: RawMail[], ownAddress: string, after: number): boolean {
  const own = ownAddress.trim().toLowerCase();
  return thread.some((m) => m.from.address.trim().toLowerCase() === own && m.date > after);
}

function referencesOf(origin: MailMessageRow): string[] {
  return [...origin.refs, origin.messageId];
}

async function ownerName(db: Db): Promise<string> {
  return (await baseProfile(db))?.data.contact.name ?? '';
}

/** `enviada`, a mensagem guardada no fio (com o texto exato) e os alertas da resposta resolvidos, numa transação. */
async function settleSent(
  db: Db, reply: MailReplyRow, origin: MailMessageRow, mail: Omit<OutgoingMail, 'attachment'>, now: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await markReplySent(tx, reply.id, now);
    await insertMailMessage(tx, {
      messageId: mail.messageId, threadKey: origin.threadKey, direction: 'out', uid: null, fromAddress: mail.from,
      fromName: mail.fromName, toAddress: mail.to, replyTo: null, subject: mail.subject, sentAt: now, body: mail.text,
      inReplyTo: mail.inReplyTo, refs: mail.references, autoSubmitted: false, listId: false, backfill: false,
      jobId: origin.jobId, linkedBy: origin.linkedBy, settled: true,
    }, now);
    await resolveAlerts(tx, { replyId: reply.id }, now);
  });
}
