import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import {
  getMailAccount, insertMailMessage, mailIgnored, mailMessages, openAlerts, requestPromote, saveMailAccount, type Db,
} from '@kv/db';
import {
  FOLDERS_HIDDEN_TEXT, MailAuthError, MailFolderError, MailTransientError, createFakeMailbox, readFakeMailbox, writeFakeMailbox, type Mailbox, type RawMail,
} from '@kv/mail';
import { ingestInbox, promoteNext, type IngestDeps } from './ingest';
import { DAY, HOUR, MAIL_NOW, MINUTE, OWNER_ADDRESS, mailTestBed } from './test-helpers';

type Bed = Awaited<ReturnType<typeof mailTestBed>>;
let bed: Bed;
let db: Db;
let dir: string;
let deps: IngestDeps;
let deliver: Bed['deliver'];
let seedAppliedJob: Bed['seedAppliedJob'];

beforeEach(async () => {
  bed = await mailTestBed();
  ({ db, dir, deliver, seedAppliedJob } = bed);
  deps = { db, mailbox: bed.mailbox, now: () => MAIL_NOW, log: () => {} };
});
afterEach(() => bed.close());

const stored = () => db.select().from(mailMessages).orderBy(asc(mailMessages.id));
const acmeJobMail = (over: Partial<RawMail> = {}): Partial<RawMail> => ({
  from: { address: 'careers@acme.com', name: 'Acme' }, subject: 'Sua candidatura na Acme', text: 'Recebemos sua candidatura.', ...over,
});
/** Põe uma mensagem que o dono enviou na pasta de enviados da caixa falsa. */
function ownerSent(mail: Partial<RawMail>): void {
  const state = readFakeMailbox(dir);
  const uid = state.messages.reduce((max, m) => Math.max(max, m.uid), 0) + 1;
  const sent = {
    uid, messageId: `sent-${uid}@example.com`, threadKey: 't1', from: { address: OWNER_ADDRESS, name: 'Maria Exemplo da Silva' },
    to: ['careers@acme.com'], replyTo: null, subject: 'Re: Sua candidatura na Acme', date: MAIL_NOW, inReplyTo: null, references: [],
    autoSubmitted: false, listId: false, bulk: false, text: 'Obrigada!', ...mail, folder: 'sent' as const,
  };
  writeFakeMailbox(dir, { ...state, messages: [...state.messages, sent] });
}

describe('ingestInbox', () => {
  it('stores job mail, lists the company mail without a hiring signal and drops the rest', async () => {
    await seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - DAY);
    deliver({ from: { address: 'careers@acme.com', name: 'Acme' }, subject: 'Sua candidatura na Acme', text: 'Recebemos sua candidatura.' });
    deliver({ from: { address: 'faturas@acme.com', name: 'Acme' }, subject: 'Sua fatura', text: 'Segue o boleto.', bulk: true });
    deliver({ from: { address: 'promo@loja.example', name: 'Loja' }, subject: 'Promoção', text: 'Compre já.' });
    const before = readFakeMailbox(dir);
    expect(await ingestInbox(deps)).toEqual({ stored: 1, ignored: 1, more: false });
    const [row] = await db.select().from(mailMessages);
    expect(row).toMatchObject({ subject: 'Sua candidatura na Acme', kind: null, direction: 'in' });
    const [ign] = await db.select().from(mailIgnored);
    expect(ign).toMatchObject({ subject: 'Sua fatura', company: 'Acme' });
    expect(JSON.stringify(ign)).not.toContain('boleto'); // o texto do ignorado não é guardado
    expect(JSON.stringify(await stored())).not.toContain('Compre');
    expect(await getMailAccount(db)).toMatchObject({ lastUid: 3, uidValidity: 1, lastReadAt: MAIL_NOW, error: null });
    expect(readFakeMailbox(dir)).toEqual(before); // a caixa do dono não muda
  });

  it('never stores the same message twice, also after UIDVALIDITY changes', async () => {
    await seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - DAY);
    deliver(acmeJobMail());
    deliver({ from: { address: 'faturas@acme.com', name: 'Acme' }, subject: 'Sua fatura', text: 'Segue o boleto.', bulk: true });
    expect(await ingestInbox(deps)).toEqual({ stored: 1, ignored: 1, more: false });
    writeFakeMailbox(dir, { ...readFakeMailbox(dir), uidValidity: 2 });
    expect(await ingestInbox(deps)).toEqual({ stored: 0, ignored: 0, more: false });
    expect(await db.select().from(mailMessages)).toHaveLength(1);
    expect(await db.select().from(mailIgnored)).toHaveLength(1);
    expect(await getMailAccount(db)).toMatchObject({ uidValidity: 2, lastUid: 2 });
  });

  it('marks mail older than the connection as backfill and ignores mail older than 30 days', async () => {
    await saveMailAccount(db, OWNER_ADDRESS, MAIL_NOW);
    // Como a busca por data do IMAP, que vale pelo dia inteiro, esta caixa devolve também o que é mais antigo que o pedido.
    const loose: Mailbox = { ...bed.mailbox, fetchInbox: (o) => bed.mailbox.fetchInbox({ ...o, since: 0 }) };
    deliver({ ...acmeJobMail(), from: { address: 'no-reply@greenhouse.io', name: 'Acme' }, date: MAIL_NOW - 5 * DAY });
    deliver({ ...acmeJobMail(), from: { address: 'no-reply@greenhouse.io', name: 'Acme' }, date: MAIL_NOW - 40 * DAY });
    deliver({ ...acmeJobMail(), from: { address: 'no-reply@greenhouse.io', name: 'Acme' }, date: MAIL_NOW + MINUTE });
    expect(await ingestInbox({ ...deps, mailbox: loose })).toEqual({ stored: 2, ignored: 0, more: false });
    const rows = await stored();
    expect(rows.map((r) => r.backfill)).toEqual([true, false]);
    expect(rows.map((r) => r.sentAt)).toEqual([MAIL_NOW - 5 * DAY, MAIL_NOW + MINUTE]);
    expect((await getMailAccount(db))!.lastUid).toBe(3);
  });

  it('pulls the rest of the thread, the owner own replies included', async () => {
    await seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - DAY);
    deliver(acmeJobMail({ threadKey: 't1', messageId: 'a@acme.com', date: MAIL_NOW - 2 * HOUR }));
    ownerSent({ inReplyTo: 'a@acme.com', references: ['a@acme.com'], date: MAIL_NOW - HOUR });
    deliver({
      from: { address: 'joana@acme.com', name: 'Joana Lima' }, subject: 'Re: Sua candidatura na Acme', text: 'Podemos conversar?',
      threadKey: 't1', messageId: 'c@acme.com', date: MAIL_NOW,
    });
    expect(await ingestInbox(deps)).toEqual({ stored: 3, ignored: 0, more: false });
    const rows = await stored();
    expect(rows.map((r) => [r.direction, r.processedAt !== null])).toEqual([['in', false], ['out', true], ['in', false]]);
    expect(rows.map((r) => r.messageId)).toEqual(['a@acme.com', 'sent-2@example.com', 'c@acme.com']);
    expect(rows[1]).toMatchObject({ fromAddress: OWNER_ADDRESS, toAddress: 'careers@acme.com', refs: ['a@acme.com'] });
  });

  it('gives a new mail of a linked thread to the same card', async () => {
    const jobId = await seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - DAY);
    await insertMailMessage(db, {
      messageId: 'old@acme.com', threadKey: 't1', direction: 'in', uid: null, fromAddress: 'joana@acme.com', fromName: 'Joana',
      toAddress: OWNER_ADDRESS, replyTo: null, subject: 'Entrevista', sentAt: MAIL_NOW - DAY, body: 'Olá', inReplyTo: null, refs: [],
      autoSubmitted: false, listId: false, backfill: false, jobId, linkedBy: 'owner',
    }, MAIL_NOW - DAY);
    // Remetente sem empresa nem sinal: passa porque o fio já é conhecido.
    deliver({ from: { address: 'pessoa@gmail.example', name: 'Pessoa' }, subject: 'Re: Entrevista', text: 'Combinado.', threadKey: 't1' });
    expect(await ingestInbox(deps)).toEqual({ stored: 1, ignored: 0, more: false });
    const rows = await stored();
    expect(rows[1]).toMatchObject({ subject: 'Re: Entrevista', jobId, linkedBy: 'owner', direction: 'in' });
  });

  it('advances the reading point only after the batch is stored', async () => {
    deliver(acmeJobMail({ from: { address: 'no-reply@greenhouse.io', name: 'Acme' } }));
    deliver(acmeJobMail({ from: { address: 'no-reply@greenhouse.io', name: 'Globex' }, subject: 'Sua candidatura na Globex' }));
    let calls = 0;
    const failing: Mailbox = {
      ...bed.mailbox,
      fetchThread: async (key) => {
        calls += 1;
        if (calls === 2) throw new Error('queda no meio do lote');
        return bed.mailbox.fetchThread(key);
      },
    };
    await expect(ingestInbox({ ...deps, mailbox: failing })).rejects.toThrow('queda no meio do lote');
    expect(await stored()).toHaveLength(1);
    expect(await getMailAccount(db)).toMatchObject({ lastUid: null, lastReadAt: null });
    expect(await ingestInbox(deps)).toEqual({ stored: 1, ignored: 0, more: false });
    expect(await stored()).toHaveLength(2);
    expect((await getMailAccount(db))!.lastUid).toBe(2);
  });

  it('pauses on a refused login and opens an alert', async () => {
    await expect(
      ingestInbox({ ...deps, mailbox: createFakeMailbox(dir, { address: 'maria@example.com', password: 'senha-errada' }) }),
    ).rejects.toBeInstanceOf(MailAuthError);
    expect(await getMailAccount(db)).toMatchObject({ paused: true, error: expect.stringContaining('recusou') });
    expect((await openAlerts(db)).map((a) => a.kind)).toEqual(['mailbox_error']);
  });

  it('records a passing error and tries again on the next round', async () => {
    deliver(acmeJobMail({ from: { address: 'no-reply@greenhouse.io', name: 'Acme' } }));
    const down: Mailbox = { ...bed.mailbox, fetchInbox: async () => { throw new MailTransientError('O Gmail não respondeu.'); } };
    await expect(ingestInbox({ ...deps, mailbox: down })).rejects.toBeInstanceOf(MailTransientError);
    expect(await getMailAccount(db)).toMatchObject({ paused: false, error: 'O Gmail não respondeu.' });
    expect(await openAlerts(db)).toEqual([]);
    expect(await ingestInbox(deps)).toEqual({ stored: 1, ignored: 0, more: false });
    expect(await getMailAccount(db)).toMatchObject({ error: null });
  });

  it('records how to show the folders when All mail is hidden from IMAP', async () => {
    deliver(acmeJobMail({ from: { address: 'no-reply@greenhouse.io', name: 'Acme' } }));
    const hidden: Mailbox = { ...bed.mailbox, fetchThread: async () => { throw new MailFolderError(FOLDERS_HIDDEN_TEXT); } };
    await expect(ingestInbox({ ...deps, mailbox: hidden })).rejects.toBeInstanceOf(MailFolderError);
    expect(await getMailAccount(db)).toMatchObject({ paused: false, error: FOLDERS_HIDDEN_TEXT, lastUid: null });
  });

  it('deletes ignored lines older than 30 days', async () => {
    await seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - DAY);
    deliver({ from: { address: 'faturas@acme.com', name: 'Acme' }, subject: 'Sua fatura', text: 'Segue o boleto.', bulk: true });
    await ingestInbox({ ...deps, now: () => MAIL_NOW - 31 * DAY });
    expect(await db.select().from(mailIgnored)).toHaveLength(1);
    await ingestInbox(deps);
    expect(await db.select().from(mailIgnored)).toHaveLength(0);
  });

  it('reads in batches', async () => {
    for (let i = 0; i < 60; i++) deliver({ from: { address: 'no-reply@greenhouse.io', name: 'Acme' }, subject: `Candidatura ${i}` });
    expect(await ingestInbox(deps)).toEqual({ stored: 50, ignored: 0, more: true });
    expect(await ingestInbox(deps)).toEqual({ stored: 10, ignored: 0, more: false });
    expect(await stored()).toHaveLength(60);
  });
});

describe('promoteNext', () => {
  it('promotes an ignored mail the owner marked', async () => {
    await seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - DAY);
    deliver({ from: { address: 'faturas@acme.com', name: 'Acme' }, subject: 'Sua fatura', text: 'Segue o boleto.', bulk: true });
    expect(await ingestInbox(deps)).toEqual({ stored: 0, ignored: 1, more: false });
    expect(await promoteNext(deps)).toBe(false);
    const [ign] = await db.select().from(mailIgnored);
    await requestPromote(db, ign!.id);
    expect(await promoteNext(deps)).toBe(true);
    expect(await stored()).toMatchObject([{ subject: 'Sua fatura', kind: null, direction: 'in', body: 'Segue o boleto.' }]);
    expect(await db.select().from(mailIgnored)).toHaveLength(0);
    expect(await promoteNext(deps)).toBe(false);
  });

  it('drops the line when the mail is no longer in the inbox', async () => {
    await seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - DAY);
    deliver({ from: { address: 'faturas@acme.com', name: 'Acme' }, subject: 'Sua fatura', text: 'Segue o boleto.', bulk: true });
    await ingestInbox(deps);
    writeFakeMailbox(dir, { ...readFakeMailbox(dir), messages: [] });
    const [ign] = await db.select().from(mailIgnored);
    await requestPromote(db, ign!.id);
    expect(await promoteNext(deps)).toBe(true);
    expect(await stored()).toEqual([]);
    expect(await db.select().from(mailIgnored)).toHaveLength(0);
  });

  it('pauses on a refused login', async () => {
    await seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - DAY);
    deliver({ from: { address: 'faturas@acme.com', name: 'Acme' }, subject: 'Sua fatura', text: 'Segue o boleto.', bulk: true });
    await ingestInbox(deps);
    const [ign] = await db.select().from(mailIgnored);
    await requestPromote(db, ign!.id);
    const refused = createFakeMailbox(dir, { address: OWNER_ADDRESS, password: 'senha-errada' });
    await expect(promoteNext({ ...deps, mailbox: refused })).rejects.toBeInstanceOf(MailAuthError);
    expect(await getMailAccount(db)).toMatchObject({ paused: true });
    expect(await db.select().from(mailIgnored)).toHaveLength(1);
  });
});
