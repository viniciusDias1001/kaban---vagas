import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import {
  applications, createReply, discardReply, getMailAccount, insertMailMessage, mailMessages, mailReplies, markReplySending,
  openAlerts, raiseAlert, replyById, saveMailAccount, saveProfile, type Db, type MailMessageRow,
} from '@kv/db';
import { resetTestDb } from '@kv/db/testing';
import {
  MailAuthError, MailTransientError, readFakeMailbox, writeFakeMailbox, type Mailbox, type OutgoingMail, type RawMail,
} from '@kv/mail';
import { createSettingsService } from '@kv/settings';
import { recoverSending, resumeForReply, sendNext, type SendDeps } from './send';
import { CONNECTED_AT, DAY, HOUR, MAIL_NOW, MINUTE, OWNER_ADDRESS, mailTestBed } from './test-helpers';

type Bed = Awaited<ReturnType<typeof mailTestBed>>;
let bed: Bed;
let db: Db;
let dir: string;
let deps: SendDeps;
let settings: ReturnType<typeof createSettingsService>;
let origin: MailMessageRow;
let jobId: number;
let replyId: number;
let ids: number;

const ORIGIN_ID = 'pedido-1@acme';
const BODY = 'Olá, Joana.\n\nMinha pretensão salarial é R$ 12.000 por mês.\n\nAtenciosamente,\nMaria Exemplo da Silva';
const PDF = { fileName: 'Curriculo_Maria_Exemplo_da_Silva_Acme.pdf', content: Buffer.from('%PDF-1.4 fake') };

beforeAll(async () => {
  bed = await mailTestBed();
  ({ db, dir } = bed);
});
afterAll(() => bed.close());

beforeEach(async () => {
  await resetTestDb(db);
  writeFakeMailbox(dir, { uidValidity: 1, messages: [] });
  await saveMailAccount(db, OWNER_ADDRESS, CONNECTED_AT);
  ids = 0;
  settings = createSettingsService(db, { env: {} });
  deps = {
    db, mailbox: bed.mailbox, now: () => MAIL_NOW, log: () => {}, settings,
    resume: async () => PDF,
    newMessageId: () => `out-${++ids}@kanban-vagas.local`,
  };
  jobId = await bed.seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - DAY);
  const mail = bed.deliver({
    messageId: ORIGIN_ID, from: { address: 'joana@acme.com', name: 'Joana Lima' }, subject: 'Pretensão salarial',
    text: 'Qual a sua pretensão salarial?', date: MAIL_NOW - HOUR,
  });
  const id = await insertMailMessage(db, {
    messageId: mail.messageId, threadKey: mail.threadKey, direction: 'in', uid: mail.uid, fromAddress: mail.from.address,
    fromName: mail.from.name, toAddress: OWNER_ADDRESS, replyTo: null, subject: mail.subject, sentAt: mail.date, body: mail.text,
    inReplyTo: null, refs: [], autoSubmitted: false, listId: false, backfill: false, jobId, linkedBy: 'auto',
  }, MAIL_NOW);
  origin = (await db.select().from(mailMessages).where(eq(mailMessages.id, id!)))[0]!;
  replyId = (await createReply(db, {
    messageId: origin.id, origin: 'facts', items: ['salary'], toAddress: 'joana@acme.com', subject: 'Re: Pretensão salarial',
    body: BODY, attachResume: false, state: 'aprovada', approvedBy: 'auto',
  }, MAIL_NOW))!;
});

const sentFolder = () => readFakeMailbox(dir).messages.filter((m) => m.folder === 'sent');
const outRows = () => db.select().from(mailMessages).where(eq(mailMessages.direction, 'out'));
/** A caixa da bancada, trocando só o que o teste precisa; conta as chamadas de `send`. */
function mailboxWith(over: Partial<Mailbox>): { mailbox: Mailbox; sends: OutgoingMail[] } {
  const sends: OutgoingMail[] = [];
  const base = bed.mailbox;
  const send = over.send ?? base.send.bind(base);
  return {
    sends,
    mailbox: {
      ...base, ...over,
      send: async (mail) => { sends.push(mail); await send(mail); },
    },
  };
}
/** Põe na pasta de enviados uma mensagem do dono no fio do pedido. */
function ownerSent(mail: Partial<RawMail>): void {
  const state = readFakeMailbox(dir);
  const uid = state.messages.reduce((max, m) => Math.max(max, m.uid), 0) + 1;
  writeFakeMailbox(dir, {
    ...state,
    messages: [...state.messages, {
      uid, messageId: `sent-${uid}@example.com`, threadKey: ORIGIN_ID, from: { address: OWNER_ADDRESS, name: 'Maria Exemplo da Silva' },
      to: ['joana@acme.com'], replyTo: null, subject: 'Re: Pretensão salarial', date: MAIL_NOW, inReplyTo: ORIGIN_ID,
      references: [ORIGIN_ID], autoSubmitted: false, listId: false, bulk: false, text: 'Respondi eu mesma.', ...mail, folder: 'sent',
    }],
  });
}
/** Uma resposta parada em `enviando`, como se o worker tivesse caído no meio do envio. */
async function stuckInSending(outMessageId: string): Promise<void> {
  expect(await markReplySending(db, replyId, outMessageId)).toBe(true);
}

describe('sendNext', () => {
  it('returns false when there is no approved reply', async () => {
    await sendNext(deps);
    expect(await sendNext(deps)).toBe(false);
  });

  it('sends an approved reply in the thread and records the exact text', async () => {
    const { mailbox, sends } = mailboxWith({});
    expect(await sendNext({ ...deps, mailbox })).toBe(true);
    expect(sends).toEqual([{
      messageId: 'out-1@kanban-vagas.local', from: OWNER_ADDRESS, fromName: '', to: 'joana@acme.com',
      subject: 'Re: Pretensão salarial', text: BODY, inReplyTo: ORIGIN_ID, references: [ORIGIN_ID], attachment: null,
    }]);
    const sent = readFakeMailbox(dir).messages.at(-1)!;
    expect(sent).toMatchObject({ folder: 'sent', to: ['joana@acme.com'], inReplyTo: ORIGIN_ID, subject: 'Re: Pretensão salarial' });
    expect(sent.references).toEqual([ORIGIN_ID]);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'enviada', sentAt: MAIL_NOW, outMessageId: 'out-1@kanban-vagas.local' });
    const [out] = await outRows();
    expect(out).toMatchObject({
      messageId: 'out-1@kanban-vagas.local', direction: 'out', body: BODY, jobId, threadKey: origin.threadKey, fromAddress: OWNER_ADDRESS,
      toAddress: 'joana@acme.com', subject: 'Re: Pretensão salarial', sentAt: MAIL_NOW, inReplyTo: ORIGIN_ID, refs: [ORIGIN_ID],
      processedAt: MAIL_NOW,
    });
  });

  it('chains the references of the origin and signs with the profile name', async () => {
    await db.update(mailMessages).set({ refs: ['first@acme', 'second@acme'] }).where(eq(mailMessages.id, origin.id));
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const { mailbox, sends } = mailboxWith({});
    await sendNext({ ...deps, mailbox });
    expect(sends[0]).toMatchObject({ fromName: 'Maria Exemplo da Silva', references: ['first@acme', 'second@acme', ORIGIN_ID] });
    expect((await outRows())[0]!.refs).toEqual(['first@acme', 'second@acme', ORIGIN_ID]);
  });

  it('gives the outgoing mail a Message-ID of the form <uuid>@kanban-vagas.local', async () => {
    const { newMessageId: _drop, ...noIds } = deps;
    await sendNext(noIds);
    const { outMessageId } = (await replyById(db, replyId))!;
    expect(outMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@kanban-vagas\.local$/);
    expect(sentFolder().map((m) => m.messageId)).toEqual([outMessageId]);
  });

  it('does not send when the owner already answered in the thread', async () => {
    await raiseAlert(db, { kind: 'draft', replyId }, MAIL_NOW);
    ownerSent({ date: MAIL_NOW - 30 * MINUTE });
    expect(await sendNext(deps)).toBe(true);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'descartada', note: 'Você já respondeu este e-mail.' });
    expect(sentFolder()).toHaveLength(1);
    expect(await outRows()).toHaveLength(0);
    expect(await openAlerts(db)).toEqual([]);
  });

  it('still sends when the owner wrote in the thread only before the request', async () => {
    ownerSent({ date: MAIL_NOW - 2 * HOUR });
    await sendNext(deps);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'enviada' });
    expect(sentFolder()).toHaveLength(2);
  });

  it('never sends the same reply twice', async () => {
    const { mailbox, sends } = mailboxWith({});
    await sendNext({ ...deps, mailbox });
    await sendNext({ ...deps, mailbox });
    expect(sends).toHaveLength(1);
    expect(sentFolder()).toHaveLength(1);
  });

  it('stops when the reply left `aprovada` before it was marked as sending', async () => {
    const { mailbox, sends } = mailboxWith({
      fetchThread: async (key) => {
        await discardReply(db, replyId, null);
        return bed.mailbox.fetchThread(key);
      },
    });
    expect(await sendNext({ ...deps, mailbox })).toBe(true);
    expect(sends).toHaveLength(0);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'descartada', outMessageId: null });
  });

  it('attaches the résumé of the application when it was asked for', async () => {
    await db.update(mailReplies).set({ attachResume: true });
    const asked: [number | null, string][] = [];
    const { mailbox, sends } = mailboxWith({});
    await sendNext({ ...deps, mailbox, resume: async (job, lang) => (asked.push([job, lang]), PDF) });
    expect(asked).toEqual([[jobId, 'pt-BR']]);
    expect(sends[0]!.attachment).toEqual({ fileName: 'Curriculo_Maria_Exemplo_da_Silva_Acme.pdf', content: PDF.content });
    expect(await replyById(db, replyId)).toMatchObject({ state: 'enviada' });
  });

  it('asks for the résumé in the language of the e-mail', async () => {
    await db.update(mailMessages).set({ lang: 'en' }).where(eq(mailMessages.id, origin.id));
    await db.update(mailReplies).set({ attachResume: true });
    const asked: string[] = [];
    await sendNext({ ...deps, resume: async (_job, lang) => (asked.push(lang), PDF) });
    expect(asked).toEqual(['en']);
  });

  it('hands the reply back to the owner when there is no résumé to attach', async () => {
    await db.update(mailReplies).set({ attachResume: true });
    const { mailbox, sends } = mailboxWith({});
    await sendNext({ ...deps, mailbox, resume: async () => null });
    expect(sends).toHaveLength(0);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'rascunho', note: 'Não há currículo para anexar.', outMessageId: null });
    expect(await openAlerts(db)).toMatchObject([{ kind: 'draft', replyId }]);
  });

  it('treats an SMTP error after delivery as sent', async () => {
    const { mailbox, sends } = mailboxWith({
      send: async (mail) => { await bed.mailbox.send(mail); throw new MailTransientError('tempo esgotado'); },
    });
    await sendNext({ ...deps, mailbox });
    expect(sends).toHaveLength(1);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'enviada', sentAt: MAIL_NOW });
    expect(await outRows()).toHaveLength(1);
    expect(await openAlerts(db)).toEqual([]);
  });

  it('marks a failed send and tells the owner, without trying again', async () => {
    const { mailbox, sends } = mailboxWith({ send: async () => { throw new Error('conexão recusada'); } });
    await sendNext({ ...deps, mailbox });
    await sendNext({ ...deps, mailbox });
    expect(sends).toHaveLength(1);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'falhou', note: 'O envio falhou. Tente de novo.' });
    expect(await openAlerts(db)).toMatchObject([{ kind: 'draft', replyId }]);
    expect(await outRows()).toHaveLength(0);
  });

  it('pauses the mailbox on a refused login and still settles the reply', async () => {
    const { mailbox, sends } = mailboxWith({ send: async () => { throw new MailAuthError('login recusado'); } });
    await sendNext({ ...deps, mailbox });
    expect(sends).toHaveLength(1);
    expect(await getMailAccount(db)).toMatchObject({ paused: true, error: 'login recusado' });
    expect(await replyById(db, replyId)).toMatchObject({ state: 'falhou' });
    const kinds = (await openAlerts(db)).map((a) => a.kind).sort();
    expect(kinds).toEqual(['draft', 'mailbox_error']);
  });

  it('leaves the reply in `enviando` when Sent cannot be checked after a failed send', async () => {
    const { mailbox, sends } = mailboxWith({
      send: async () => { throw new MailTransientError('conexão caiu'); },
      sentExists: async () => { throw new MailTransientError('conexão caiu'); },
    });
    await expect(sendNext({ ...deps, mailbox })).rejects.toThrow('conexão caiu');
    expect(sends).toHaveLength(1);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'enviando', outMessageId: 'out-1@kanban-vagas.local' });
    await sendNext({ ...deps, mailbox });
    expect(sends).toHaveLength(1);
  });

  it('clears the alerts of a reply once it is sent', async () => {
    await raiseAlert(db, { kind: 'interview', replyId }, MAIL_NOW);
    expect(await openAlerts(db)).toHaveLength(1);
    await sendNext(deps);
    expect(await openAlerts(db)).toEqual([]);
  });

  it('never sends twice a reply that was delivered, ended `falhou` and was approved again', async () => {
    // O SMTP deu erro depois de o Gmail aceitar; a cópia em Enviados ainda não tinha aparecido.
    const { mailbox, sends } = mailboxWith({
      send: async (mail) => { await bed.mailbox.send(mail); throw new MailTransientError('tempo esgotado'); },
      sentExists: async () => false,
    });
    await sendNext({ ...deps, mailbox });
    expect(await replyById(db, replyId)).toMatchObject({ state: 'falhou', outMessageId: 'out-1@kanban-vagas.local' });
    const state = readFakeMailbox(dir);
    writeFakeMailbox(dir, { ...state, messages: state.messages.map((m) => (m.folder === 'sent' ? { ...m, date: MAIL_NOW } : m)) });
    // O dono aprova de novo; agora a cópia está no fio.
    await db.update(mailReplies).set({ state: 'aprovada', approvedBy: 'owner' }).where(eq(mailReplies.id, replyId));
    await sendNext({ ...deps, mailbox });
    expect(sends).toHaveLength(1);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'descartada', note: 'Você já respondeu este e-mail.' });
  });

  /** Um segundo pedido no mesmo fio, um minuto depois do primeiro, com a resposta aprovada depois da primeira. */
  async function secondRequestInThread(): Promise<number> {
    const mail = bed.deliver({
      messageId: 'pedido-2@acme', threadKey: origin.threadKey, from: { address: 'joana@acme.com', name: 'Joana Lima' },
      subject: 'Re: Pretensão salarial', text: 'Pode mandar o CV?', date: MAIL_NOW - HOUR + MINUTE,
      inReplyTo: ORIGIN_ID, references: [ORIGIN_ID],
    });
    const id = (await insertMailMessage(db, {
      messageId: mail.messageId, threadKey: origin.threadKey, direction: 'in', uid: mail.uid, fromAddress: mail.from.address,
      fromName: mail.from.name, toAddress: OWNER_ADDRESS, replyTo: null, subject: mail.subject, sentAt: mail.date, body: mail.text,
      inReplyTo: ORIGIN_ID, refs: [ORIGIN_ID], autoSubmitted: false, listId: false, backfill: false, jobId, linkedBy: 'auto',
    }, MAIL_NOW))!;
    const second = (await createReply(db, {
      messageId: id, origin: 'facts', items: ['resume'], toAddress: 'joana@acme.com', subject: 'Re: Pretensão salarial',
      body: 'Segue o currículo.', attachResume: false, state: 'aprovada', approvedBy: 'auto',
    }, MAIL_NOW + 1))!;
    return second;
  }

  it('does not take its own earlier reply in the thread as the owner answering', async () => {
    const second = await secondRequestInThread();
    const { mailbox, sends } = mailboxWith({});
    await sendNext({ ...deps, mailbox });
    // A cópia em Enviados da primeira resposta é posterior ao segundo pedido.
    const state = readFakeMailbox(dir);
    writeFakeMailbox(dir, { ...state, messages: state.messages.map((m) => (m.folder === 'sent' ? { ...m, date: MAIL_NOW } : m)) });
    await sendNext({ ...deps, mailbox, now: () => MAIL_NOW + MINUTE });
    expect(sends.map((s) => s.text)).toEqual([BODY, 'Segue o currículo.']);
    expect(await replyById(db, second)).toMatchObject({ state: 'enviada' });
  });

  it('hands the reply back when preparing it fails, and the next approved reply still goes out', async () => {
    await db.update(mailReplies).set({ attachResume: true }).where(eq(mailReplies.id, replyId));
    const second = await secondRequestInThread();
    const { mailbox, sends } = mailboxWith({});
    const resume = async () => { throw new Error('glifo ausente: 🙂'); };
    expect(await sendNext({ ...deps, mailbox, resume })).toBe(true);
    expect(sends).toHaveLength(0);
    expect(await replyById(db, replyId)).toMatchObject({
      state: 'rascunho', note: 'Não foi possível preparar o envio. Confira a resposta e aprove de novo.', outMessageId: null,
    });
    expect(await openAlerts(db)).toMatchObject([{ kind: 'draft', replyId }]);
    expect(await sendNext({ ...deps, mailbox, resume })).toBe(true);
    expect(await replyById(db, second)).toMatchObject({ state: 'enviada' });
  });

  it('raises no draft alert when the owner discarded the reply while it was being prepared', async () => {
    await db.update(mailReplies).set({ attachResume: true }).where(eq(mailReplies.id, replyId));
    const resume = async () => { await discardReply(db, replyId, null); return null; };
    expect(await sendNext({ ...deps, resume })).toBe(true);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'descartada' });
    expect(await openAlerts(db)).toEqual([]);
  });

  it('still lets a mailbox error through when preparing fails', async () => {
    const { mailbox } = mailboxWith({ fetchThread: async () => { throw new MailTransientError('caiu'); } });
    await expect(sendNext({ ...deps, mailbox })).rejects.toThrow('caiu');
    expect(await replyById(db, replyId)).toMatchObject({ state: 'aprovada' });
  });

  describe('an automatic reply is checked again before it goes out', () => {
    const CHANGED = 'As condições do envio automático mudaram. Confira e aprove.';
    async function expectHandedBack(): Promise<void> {
      const { mailbox, sends } = mailboxWith({});
      expect(await sendNext({ ...deps, mailbox })).toBe(true);
      expect(sends).toHaveLength(0);
      expect(await replyById(db, replyId)).toMatchObject({ state: 'rascunho', note: CHANGED, approvedBy: null });
      expect(await openAlerts(db)).toMatchObject([{ kind: 'draft', replyId, payload: { reason: CHANGED } }]);
    }

    it('when the facts mode is no longer automatic', async () => {
      await settings.update({ emailFactsMode: 'approve' });
      await expectHandedBack();
    });

    it('when the mail is no longer linked to a card', async () => {
      await db.update(mailMessages).set({ jobId: null }).where(eq(mailMessages.id, origin.id));
      await expectHandedBack();
    });

    it('when the address is no longer trusted for the card', async () => {
      await db.update(mailReplies).set({ toAddress: 'x@acme.phish.io' }).where(eq(mailReplies.id, replyId));
      await expectHandedBack();
    });

    it('but a reply the owner approved goes out whatever the mode', async () => {
      await settings.update({ emailFactsMode: 'off' });
      await db.update(mailReplies).set({ approvedBy: 'owner', toAddress: 'dados@fora.example' }).where(eq(mailReplies.id, replyId));
      await sendNext(deps);
      expect(await replyById(db, replyId)).toMatchObject({ state: 'enviada' });
    });
  });
});

describe('recoverSending', () => {
  it('after a crash, finds the mail in Sent and marks it sent', async () => {
    await stuckInSending('out-1@kanban-vagas.local');
    ownerSent({ messageId: 'out-1@kanban-vagas.local', text: BODY });
    const { mailbox, sends } = mailboxWith({});
    expect(await recoverSending({ ...deps, mailbox })).toEqual({ sent: 1, returned: 0 });
    expect(sends).toHaveLength(0);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'enviada', sentAt: MAIL_NOW });
    expect(sentFolder()).toHaveLength(1); // nada reenviado
    expect(await outRows()).toMatchObject([{ messageId: 'out-1@kanban-vagas.local', body: BODY, jobId, threadKey: origin.threadKey }]);
  });

  it('after a crash, hands the reply back to the owner when the mail is not in Sent', async () => {
    await stuckInSending('out-1@kanban-vagas.local');
    const { mailbox, sends } = mailboxWith({});
    expect(await recoverSending({ ...deps, mailbox })).toEqual({ sent: 0, returned: 1 });
    expect(sends).toHaveLength(0);
    expect(await replyById(db, replyId)).toMatchObject({ state: 'rascunho', approvedAt: null });
    expect((await openAlerts(db))[0]).toMatchObject({ kind: 'draft', replyId });
    expect(await outRows()).toHaveLength(0);
  });

  it('does nothing when no reply is in `enviando`', async () => {
    expect(await recoverSending(deps)).toEqual({ sent: 0, returned: 0 });
    expect(await replyById(db, replyId)).toMatchObject({ state: 'aprovada' });
  });
});

describe('resumeForReply', { timeout: 60_000 }, () => {
  it('uses the PDF stored with the application of the job', async () => {
    await db.insert(applications).values({
      jobId, site: 'linkedin', status: 'submitted', trigger: 'manual', mode: 'dry_run', createdAt: 1,
      resumePdf: PDF.content, resumeFileName: PDF.fileName, resumeLang: 'pt-BR',
    });
    expect(await resumeForReply(db)(jobId, 'en')).toEqual(PDF);
  });

  it('renders the base profile when the job has no stored résumé', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const pdf = await resumeForReply(db)(jobId, 'pt-BR');
    expect(pdf!.fileName).toBe('Curriculo_Maria_Exemplo_da_Silva_Acme.pdf');
    expect(pdf!.content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('names the company "Empresa" when the e-mail has no card', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    expect((await resumeForReply(db)(null, 'pt-BR'))!.fileName).toBe('Curriculo_Maria_Exemplo_da_Silva_Empresa.pdf');
  });

  it('is null without a profile', async () => {
    expect(await resumeForReply(db)(jobId, 'pt-BR')).toBeNull();
  });
});
