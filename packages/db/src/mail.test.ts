import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './index';
import {
  countUnclassified, deleteIgnored, deleteMailAccount, forceClassifyAll, getMailAccount, insertIgnored, insertMailMessage,
  knownMessageIds, linkThreadToJob, listIgnored, mailMatchPool, mailMessageById, markProcessed, nextPromoted, nextUnclassified,
  nextUnprocessed, pruneIgnored, reopenMessage, requestPromote, saveClassification, saveMailAccount, threadJobs, threadMessages,
  unlinkThread, updateMailAccount, jobEmails, listMailMessages, type NewIgnored, type NewMailMessage,
} from './mail';
import { raiseAlert, resolveAlerts } from './mail-alerts';
import { createReply, markReplySending, markReplySent } from './mail-replies';
import { applications, jobEvents, jobs } from './schema';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

let seq = 0;
async function seedJob(extra: Partial<typeof jobs.$inferInsert> = {}) {
  seq += 1;
  const url = `https://example.com/mail-${seq}`;
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: url, url, title: 'Dev', company: 'Acme', location: 'Remoto', country: 'BR',
      remote: true, level: null, stacks: [], description: '', postedAt: null, discoveredAt: 1_000_000, dedupHash: url,
      profileId: null, position: seq, ...extra,
    })
    .returning();
  return row;
}

const msg = (extra: Partial<NewMailMessage> = {}): NewMailMessage => ({
  messageId: 'm@x', threadKey: 't', direction: 'in', uid: 1, fromAddress: 'rh@acme.example', fromName: 'RH Acme',
  toAddress: 'maria@example.com', replyTo: null, subject: 'Sua candidatura', sentAt: 100, body: 'Olá, Maria Exemplo da Silva.',
  inReplyTo: null, refs: [], autoSubmitted: false, listId: false, backfill: false, ...extra,
});
const ignored = (extra: Partial<NewIgnored> = {}): NewIgnored => ({
  messageId: 'i@x', uid: 9, fromAddress: 'news@globex.example', fromName: 'Globex', subject: 'Novidades', sentAt: 100, company: 'Globex', ...extra,
});
const classification = (jobId: number | null) => ({ kind: 'recebimento' as const, summary: 'Recebemos.', lang: 'pt-BR' as const, requests: [], jobId });

describe('mailbox account', () => {
  it('reconnecting resets the reading point and clears the error', async () => {
    expect(await getMailAccount(db)).toBeNull();
    await saveMailAccount(db, 'maria@example.com', 1000);
    await updateMailAccount(db, { lastUid: 50, uidValidity: 7, paused: true, error: 'senha recusada', backfillDone: true });
    expect(await getMailAccount(db)).toMatchObject({ lastUid: 50, uidValidity: 7, paused: true, backfillDone: true });
    await saveMailAccount(db, 'maria@example.com', 2000);
    expect(await getMailAccount(db)).toMatchObject({
      id: 1, address: 'maria@example.com', connectedAt: 2000, lastUid: null, uidValidity: null, paused: false, error: null, backfillDone: false,
    });
    await deleteMailAccount(db);
    expect(await getMailAccount(db)).toBeNull();
  });
});

describe('stored messages', () => {
  it('stores a message once per Message-ID, also when it was ignored before', async () => {
    expect(await insertMailMessage(db, msg({ messageId: 'a@x' }), 1000)).toEqual(expect.any(Number));
    expect(await insertMailMessage(db, msg({ messageId: 'a@x' }), 1001)).toBeNull();
    await insertIgnored(db, ignored({ messageId: 'b@x' }), 1000);
    expect(await insertMailMessage(db, msg({ messageId: 'b@x' }), 1001)).toBeNull();
    expect(await knownMessageIds(db, ['a@x', 'b@x', 'c@x'])).toEqual(new Set(['a@x', 'b@x']));
    expect(await knownMessageIds(db, [])).toEqual(new Set());
  });

  it('builds the match pool from applied cards and submitted applications', async () => {
    const acme = await seedJob({ company: 'Acme', column: 'aplicada' });
    await db.insert(applications).values({ jobId: acme.id, site: 'fake', trigger: 'auto', mode: 'real', status: 'submitted', createdAt: 4000, submittedAt: 5000 });
    await db.insert(jobEvents).values({ jobId: acme.id, fromColumn: 'descobertas', toColumn: 'aplicada', actor: 'humano', createdAt: 4500 });
    const globex = await seedJob({ company: 'Globex', column: 'entrevista', country: 'INT' });
    await db.insert(jobEvents).values([
      { jobId: globex.id, fromColumn: 'descobertas', toColumn: 'aplicada', actor: 'humano', createdAt: 3000 },
      { jobId: globex.id, fromColumn: 'aplicada', toColumn: 'entrevista', actor: 'humano', createdAt: 3500 },
    ]);
    await seedJob({ company: 'Initech', column: 'descobertas' });
    const submittedOnly = await seedJob({ company: 'Umbrella', column: 'selecionadas' });
    await db.insert(applications).values({ jobId: submittedOnly.id, site: 'fake', trigger: 'auto', mode: 'real', status: 'submitted', createdAt: 1, submittedAt: 7000 });
    const noEvents = await seedJob({ company: 'Hooli', column: 'aplicada', discoveredAt: 111 });
    const lastEvent = await seedJob({ company: 'Soylent', column: 'oferta' });
    await db.insert(jobEvents).values([
      { jobId: lastEvent.id, fromColumn: 'descobertas', toColumn: 'selecionadas', actor: 'humano', createdAt: 800 },
      { jobId: lastEvent.id, fromColumn: 'selecionadas', toColumn: 'oferta', actor: 'humano', createdAt: 900 },
    ]);
    const pool = await mailMatchPool(db);
    expect(pool).toEqual([
      { jobId: acme.id, company: 'Acme', title: 'Dev', country: 'BR', appliedAt: 5000 },
      { jobId: globex.id, company: 'Globex', title: 'Dev', country: 'INT', appliedAt: 3000 },
      { jobId: submittedOnly.id, company: 'Umbrella', title: 'Dev', country: 'BR', appliedAt: 7000 },
      { jobId: noEvents.id, company: 'Hooli', title: 'Dev', country: 'BR', appliedAt: 111 },
      { jobId: lastEvent.id, company: 'Soylent', title: 'Dev', country: 'BR', appliedAt: 900 },
    ]);
  });

  it('hands out work oldest first and skips settled messages', async () => {
    await insertMailMessage(db, msg({ messageId: 'a@x', sentAt: 300 }), 1);
    const b = (await insertMailMessage(db, msg({ messageId: 'b@x', sentAt: 100 }), 1))!;
    await insertMailMessage(db, msg({ messageId: 'c@x', sentAt: 200 }), 1);
    await insertMailMessage(db, msg({ messageId: 'own@x', direction: 'out', sentAt: 50, settled: true }), 1);
    expect(await countUnclassified(db)).toBe(3);
    expect((await nextUnclassified(db))!.id).toBe(b);
    expect(await nextUnclassified(db, { onlyForced: true })).toBeNull();
    expect(await nextUnprocessed(db)).toBeNull();
    for (const m of ['a@x', 'b@x', 'c@x']) {
      const [row] = (await threadMessages(db, 't')).filter((r) => r.messageId === m);
      await saveClassification(db, row.id, classification(null), 10);
    }
    expect(await countUnclassified(db)).toBe(0);
    expect((await nextUnprocessed(db))!.id).toBe(b);
    await markProcessed(db, b, 20);
    expect((await nextUnprocessed(db))!.sentAt).toBe(200);
    expect(await mailMessageById(db, b)).toMatchObject({ kind: 'recebimento', classifiedAt: 10, processedAt: 20 });
    expect(await reopenMessage(db, b)).toBe(true);
    expect((await nextUnprocessed(db))!.id).toBe(b);
    expect(await reopenMessage(db, 9999)).toBe(false);
  });

  it('breaks date ties by id', async () => {
    const first = (await insertMailMessage(db, msg({ messageId: 'a@x', sentAt: 100 }), 1))!;
    await insertMailMessage(db, msg({ messageId: 'b@x', sentAt: 100 }), 1);
    expect((await nextUnclassified(db))!.id).toBe(first);
  });

  it('force-classifies the waiting messages', async () => {
    const a = (await insertMailMessage(db, msg({ messageId: 'a@x', sentAt: 200 }), 1))!;
    const b = (await insertMailMessage(db, msg({ messageId: 'b@x', sentAt: 100 }), 1))!;
    await insertMailMessage(db, msg({ messageId: 'own@x', direction: 'out', settled: true }), 1);
    expect(await forceClassifyAll(db)).toBe(2);
    expect(await forceClassifyAll(db)).toBe(0);
    expect((await nextUnclassified(db, { onlyForced: true }))!.id).toBe(b);
    await saveClassification(db, b, classification(null), 5);
    expect((await nextUnclassified(db, { onlyForced: true }))!.id).toBe(a);
    expect((await mailMessageById(db, b))!.forceClassify).toBe(false);
  });

  it('classification links the card automatically only when there is one', async () => {
    const job = await seedJob();
    const a = (await insertMailMessage(db, msg({ messageId: 'a@x' }), 1))!;
    await saveClassification(db, a, classification(job.id), 10);
    expect(await mailMessageById(db, a)).toMatchObject({ jobId: job.id, linkedBy: 'auto' });
    await saveClassification(db, a, classification(null), 11);
    expect(await mailMessageById(db, a)).toMatchObject({ jobId: null, linkedBy: null });
  });

  it('linking a message gives the whole thread to the card and reopens the message', async () => {
    const job = await seedJob();
    const first = (await insertMailMessage(db, msg({ messageId: 'a@x', threadKey: 't1', sentAt: 100 }), 1))!;
    const second = (await insertMailMessage(db, msg({ messageId: 'b@x', threadKey: 't1', sentAt: 200 }), 1))!;
    await saveClassification(db, first, classification(null), 5);
    await markProcessed(db, first, 6);
    expect(await linkThreadToJob(db, first, job.id, 9000)).toBe(true);
    expect(await threadJobs(db, ['t1', 'desconhecido'])).toEqual(new Map([['t1', job.id]]));
    expect(await mailMessageById(db, first)).toMatchObject({ jobId: job.id, linkedBy: 'owner', processedAt: null });
    expect(await mailMessageById(db, second)).toMatchObject({ jobId: job.id, linkedBy: 'owner' });
    expect(await linkThreadToJob(db, 9999, job.id)).toBe(false);
    expect((await threadMessages(db, 't1')).map((m) => m.id)).toEqual([first, second]);
  });

  it('threadJobs answers null for a known thread without a card', async () => {
    await insertMailMessage(db, msg({ messageId: 'a@x', threadKey: 't1' }), 1);
    expect(await threadJobs(db, ['t1'])).toEqual(new Map([['t1', null]]));
  });

  it('unlinking marks the thread as corrected by the owner', async () => {
    const job = await seedJob();
    const a = (await insertMailMessage(db, msg({ messageId: 'a@x', threadKey: 't1', jobId: job.id, linkedBy: 'auto' }), 1))!;
    const b = (await insertMailMessage(db, msg({ messageId: 'b@x', threadKey: 't1', jobId: job.id, linkedBy: 'auto' }), 1))!;
    expect(await unlinkThread(db, a)).toBe(true);
    for (const id of [a, b]) expect(await mailMessageById(db, id)).toMatchObject({ jobId: null, linkedBy: 'owner', corrected: true });
    expect(await threadJobs(db, ['t1'])).toEqual(new Map([['t1', null]]));
    expect(await unlinkThread(db, 9999)).toBe(false);
  });

  it('a later automatic classification does not overrule the owner link', async () => {
    const jobA = await seedJob({ company: 'Acme' });
    const jobB = await seedJob({ company: 'Globex' });
    const first = (await insertMailMessage(db, msg({ messageId: 'a@x', threadKey: 't1' }), 1))!;
    const later = (await insertMailMessage(db, msg({ messageId: 'b@x', threadKey: 't1', sentAt: 200 }), 1))!;
    await linkThreadToJob(db, first, jobA.id, 2);
    await saveClassification(db, later, classification(jobB.id), 3);
    expect(await mailMessageById(db, later)).toMatchObject({ jobId: jobA.id, linkedBy: 'owner' });
    await saveClassification(db, first, classification(jobB.id), 4);
    expect(await mailMessageById(db, first)).toMatchObject({ jobId: jobA.id, linkedBy: 'owner' });
    expect(await threadJobs(db, ['t1'])).toEqual(new Map([['t1', jobA.id]]));
  });
});

describe('job mail lists', () => {
  it('says what the app did with each mail', async () => {
    // one mail moved the card to perdida and has no reply or alert; one has a sent reply (origin facts, approved auto); one has an alert
    const job = await seedJob({ column: 'perdida' });
    const movedId = (await insertMailMessage(db, msg({ messageId: 'a@x', jobId: job.id, linkedBy: 'auto', sentAt: 100 }), 1))!;
    await db.insert(jobEvents).values({ jobId: job.id, fromColumn: 'aplicada', toColumn: 'perdida', actor: 'email', mailMessageId: movedId, createdAt: 500 });
    const repliedId = (await insertMailMessage(db, msg({ messageId: 'b@x', sentAt: 200 }), 1))!;
    const replyId = (await createReply(db, {
      messageId: repliedId, origin: 'facts', items: ['phone'], toAddress: 'rh@acme.example', subject: 'Re: Telefone', body: 'Meu telefone.',
      attachResume: false, state: 'aprovada', approvedBy: 'auto',
    }, 300))!;
    await markReplySending(db, replyId, '<out@x>', 301);
    await markReplySent(db, replyId, 302);
    const alertedId = (await insertMailMessage(db, msg({ messageId: 'c@x', sentAt: 300 }), 1))!;
    await raiseAlert(db, { kind: 'interview', mailMessageId: alertedId }, 400);

    const list = await listMailMessages(db, {});
    expect(list.find((m) => m.id === movedId)).toMatchObject({ movedTo: 'perdida', replyState: null, replyOrigin: null, replyApprovedBy: null, alerted: false });
    expect(list.find((m) => m.id === repliedId)).toMatchObject({ replyState: 'enviada', replyOrigin: 'facts', replyApprovedBy: 'auto' });
    expect(list.find((m) => m.id === alertedId)).toMatchObject({ alerted: true });
  });

  it('counts an alert reached through the reply, also once closed, and says when a move can be undone', async () => {
    const job = await seedJob({ column: 'entrevista', company: 'Globex', title: 'Dev Pleno' });
    const invite = (await insertMailMessage(db, msg({ messageId: 'a@x', jobId: job.id, linkedBy: 'auto', sentAt: 100 }), 1))!;
    await db.insert(jobEvents).values({ jobId: job.id, fromColumn: 'aplicada', toColumn: 'entrevista', actor: 'email', mailMessageId: invite, createdAt: 500 });
    const replyId = (await createReply(db, {
      messageId: invite, origin: 'ai', items: [], toAddress: 'rh@acme.example', subject: 'Re: Convite', body: 'Posso.',
      attachResume: false, state: 'rascunho',
    }, 300))!;
    await raiseAlert(db, { kind: 'draft', replyId }, 400);
    await resolveAlerts(db, { replyId }, 450);

    const [dto] = await listMailMessages(db);
    expect(dto).toMatchObject({
      id: invite, company: 'Globex', jobTitle: 'Dev Pleno', movedTo: 'entrevista', canUndoMove: true, alerted: true,
      replyState: 'rascunho', replyOrigin: 'ai', replyApprovedBy: null,
    });
    // O dono mexeu no card depois: o movimento do e-mail deixou de ser o último.
    await db.insert(jobEvents).values({ jobId: job.id, fromColumn: 'entrevista', toColumn: 'oferta', actor: 'humano', createdAt: 600 });
    expect((await listMailMessages(db))[0]).toMatchObject({ movedTo: 'entrevista', canUndoMove: false });
  });

  it('filters by kind, missing card and date, newest first', async () => {
    const job = await seedJob();
    const old = (await insertMailMessage(db, msg({ messageId: 'a@x', jobId: job.id, linkedBy: 'auto', sentAt: 100 }), 1))!;
    const loose = (await insertMailMessage(db, msg({ messageId: 'b@x', sentAt: 200 }), 1))!;
    const recent = (await insertMailMessage(db, msg({ messageId: 'c@x', jobId: job.id, linkedBy: 'auto', sentAt: 300 }), 1))!;
    await saveClassification(db, old, { ...classification(job.id), kind: 'reprovacao' }, 2);
    expect((await listMailMessages(db)).map((m) => m.id)).toEqual([recent, loose, old]);
    expect((await listMailMessages(db, { kind: 'reprovacao' })).map((m) => m.id)).toEqual([old]);
    expect((await listMailMessages(db, { unmatched: true })).map((m) => m.id)).toEqual([loose]);
    expect((await listMailMessages(db, { since: 200 })).map((m) => m.id)).toEqual([recent, loose]);
  });

  it('gives the conversation of a card oldest first, with its replies', async () => {
    const job = await seedJob();
    const asked = (await insertMailMessage(db, msg({ messageId: 'a@x', jobId: job.id, linkedBy: 'auto', sentAt: 100 }), 1))!;
    const answer = (await insertMailMessage(db, msg({ messageId: 'b@x', direction: 'out', jobId: job.id, linkedBy: 'auto', sentAt: 200 }), 1))!;
    await insertMailMessage(db, msg({ messageId: 'c@x', sentAt: 150 }), 1);
    const replyId = (await createReply(db, {
      messageId: asked, origin: 'facts', items: ['phone'], toAddress: 'rh@acme.example', subject: 'Re: Telefone', body: 'Meu telefone.',
      attachResume: false, state: 'rascunho',
    }, 300))!;
    const emails = await jobEmails(db, job.id);
    expect(emails.messages.map((m) => m.id)).toEqual([asked, answer]);
    expect(emails.replies).toEqual([expect.objectContaining({ id: replyId, messageId: asked, state: 'rascunho' })]);
    expect(await jobEmails(db, 9999)).toEqual({ messages: [], replies: [] });
  });
});

describe('ignored mail', () => {
  it('lists the newest first, with the promote flag as promoted', async () => {
    await insertIgnored(db, ignored({ messageId: 'a@x', sentAt: 100 }), 1);
    await insertIgnored(db, ignored({ messageId: 'b@x', sentAt: 300 }), 1);
    await insertIgnored(db, ignored({ messageId: 'a@x', sentAt: 999 }), 1);
    const list = await listIgnored(db);
    expect(list.map((i) => i.sentAt)).toEqual([300, 100]);
    expect(list[0]).toEqual({
      id: expect.any(Number), fromAddress: 'news@globex.example', fromName: 'Globex', subject: 'Novidades', sentAt: 300, company: 'Globex', promoted: false,
    });
  });

  it('prunes ignored mail older than the limit and promotes on request', async () => {
    await insertIgnored(db, ignored({ messageId: 'old@x', sentAt: 10 }), 1000);
    await insertIgnored(db, ignored({ messageId: 'new@x', sentAt: 20 }), 5000);
    await insertIgnored(db, ignored({ messageId: 'edge@x', sentAt: 30 }), 3000);
    expect(await pruneIgnored(db, 3000)).toBe(1);
    const left = await listIgnored(db);
    expect(left.map((i) => i.sentAt)).toEqual([30, 20]);
    expect(await nextPromoted(db)).toBeNull();
    expect(await requestPromote(db, left[1].id)).toBe(true);
    expect(await requestPromote(db, 9999)).toBe(false);
    expect(await nextPromoted(db)).toMatchObject({ id: left[1].id, messageId: 'new@x', uid: 9, promote: true });
    expect((await listIgnored(db)).find((i) => i.id === left[1].id)!.promoted).toBe(true);
    await deleteIgnored(db, left[1].id);
    expect(await nextPromoted(db)).toBeNull();
  });
});
