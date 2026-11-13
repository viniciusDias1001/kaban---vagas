import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alertById, closeDb, createReply, insertIgnored, insertMailMessage, jobEvents, jobs, mailMessageById, mailMessages,
  markReplySending, markReplySent, raiseAlert, replyById, type Db, type NewMailMessage,
} from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { eq } from 'drizzle-orm';
import { TEST_SECRET, seedJob, testAi } from './ai-testing';
import { buildApp } from './app';

const NOW = Date.UTC(2026, 10, 13, 15, 0, 0);

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi({ env: { APP_SECRET: TEST_SECRET }, now: () => NOW }) });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => closeDb(db));

const get = (url: string) => app.inject({ method: 'GET', url });
const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, ...(payload ? { payload } : {}) });
const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url, payload });

let seq = 0;
/** Mensagem recebida, já classificada (tipo dado) e ligada à vaga dada. */
async function seedMail(over: Partial<NewMailMessage> & { kind?: string | null; processed?: boolean } = {}) {
  seq += 1;
  const { kind = 'recebimento', processed = true, ...rest } = over;
  const id = await insertMailMessage(db, {
    messageId: `<${seq}@acme.example>`, threadKey: `<t${seq}@acme.example>`, direction: 'in', uid: seq,
    fromAddress: 'rh@acme.example', fromName: 'RH Acme', toAddress: 'maria@example.com', replyTo: null,
    subject: 'Recebemos sua candidatura', sentAt: NOW - 10_000 + seq, body: 'Olá, Maria Exemplo da Silva.', inReplyTo: null,
    refs: [], autoSubmitted: false, listId: false, backfill: false, ...rest,
  }, NOW);
  await db
    .update(mailMessages)
    .set({ kind: kind as never, classifiedAt: kind ? NOW : null, processedAt: processed ? NOW : null })
    .where(eq(mailMessages.id, id!));
  return id!;
}

async function draftFor(messageId: number, body = 'Posso na [[dia e hora]].\n\nMaria Exemplo da Silva') {
  const id = await createReply(db, {
    messageId, origin: 'ai', items: [], toAddress: 'rh@acme.example', subject: 'Re: Convite para entrevista', body,
    attachResume: false, state: 'rascunho',
  }, NOW);
  return id!;
}

async function sentReplyFor(messageId: number) {
  const id = await createReply(db, {
    messageId, origin: 'facts', items: ['phone'], toAddress: 'rh@acme.example', subject: 'Re: Telefone', body: 'Meu telefone.',
    attachResume: false, state: 'aprovada', approvedBy: 'auto',
  }, NOW);
  await markReplySending(db, id!, '<out@kv.local>', NOW);
  await markReplySent(db, id!, NOW);
  return id!;
}

describe('job mail', () => {
  it('lists job mail newest first and filters by kind and by missing card', async () => {
    const job = await seedJob(db, { company: 'Acme' });
    await seedMail({ jobId: job.id, linkedBy: 'auto', subject: 'Recebemos sua candidatura' });
    await seedMail({ jobId: job.id, linkedBy: 'auto', subject: 'Sua candidatura na Acme', kind: 'reprovacao' });
    await seedMail({ subject: 'Uma vaga sem card', kind: 'outro' });

    const all = (await get('/email/messages')).json();
    expect(all.map((m: { subject: string }) => m.subject)).toEqual(['Uma vaga sem card', 'Sua candidatura na Acme', 'Recebemos sua candidatura']);
    expect(all[1]).toMatchObject({ company: 'Acme', jobTitle: 'Dev React', jobId: job.id, kind: 'reprovacao' });
    expect((await get('/email/messages?kind=reprovacao')).json().map((m: { subject: string }) => m.subject)).toEqual(['Sua candidatura na Acme']);
    const unmatched = (await get('/email/messages?unmatched=1')).json();
    expect(unmatched).toHaveLength(1);
    expect(unmatched.every((m: { jobId: number | null }) => m.jobId === null)).toBe(true);
    expect((await get(`/email/messages?since=${NOW - 10_000 + 3}`)).json().map((m: { subject: string }) => m.subject)).toEqual(['Uma vaga sem card']);
    expect((await get('/email/messages?kind=nada')).statusCode).toBe(400);
  });

  it('returns the conversation of a card with its replies', async () => {
    const job = await seedJob(db);
    const asked = await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'pedido', subject: 'Qual o seu telefone?' });
    await sentReplyFor(asked);
    await seedMail({ jobId: job.id, linkedBy: 'auto', direction: 'out', kind: null, subject: 'Re: Qual o seu telefone?', threadKey: '<t-out>' });
    await seedMail({ subject: 'De outra vaga' });

    const res = (await get(`/jobs/${job.id}/emails`)).json();
    expect(res).toMatchObject({ messages: [{ direction: 'in' }, { direction: 'out' }], replies: [{ state: 'enviada' }] });
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0]).toMatchObject({ replyState: 'enviada', replyOrigin: 'facts', replyApprovedBy: 'auto' });
    expect((await get('/jobs/999/emails')).statusCode).toBe(404);
    expect((await get('/jobs/abc/emails')).json()).toMatchObject({ error: 'not_found' });
  });

  it('links a mail without a card and clears its alert', async () => {
    const job = await seedJob(db);
    const id = await seedMail({ kind: 'entrevista' });
    await raiseAlert(db, { kind: 'unmatched', mailMessageId: id }, NOW);
    expect((await get('/alerts')).json().alerts).toHaveLength(1);

    expect((await post(`/email/messages/${id}/link`, { jobId: job.id })).statusCode).toBe(200);
    expect((await get('/alerts')).json().alerts).toEqual([]);
    expect((await mailMessageById(db, id))!).toMatchObject({ jobId: job.id, linkedBy: 'owner', processedAt: null });
  });

  it('refuses to link to a card or a mail that does not exist', async () => {
    const job = await seedJob(db);
    const id = await seedMail();
    expect((await post(`/email/messages/${id}/link`, { jobId: 999 })).statusCode).toBe(404);
    expect((await post('/email/messages/999/link', { jobId: job.id })).statusCode).toBe(404);
    expect((await post(`/email/messages/${id}/link`, { jobId: 'x' })).statusCode).toBe(400);
    expect((await mailMessageById(db, id))!.jobId).toBeNull();
  });

  it('unlinks a thread from its card', async () => {
    const job = await seedJob(db);
    const id = await seedMail({ jobId: job.id, linkedBy: 'auto' });
    expect((await post(`/email/messages/${id}/unlink`)).statusCode).toBe(200);
    expect((await mailMessageById(db, id))!).toMatchObject({ jobId: null, linkedBy: 'owner', corrected: true });
    expect((await post('/email/messages/999/unlink')).statusCode).toBe(404);
  });

  it('undoes a move made by mail once', async () => {
    const job = await seedJob(db, { column: 'perdida' });
    const id = await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'reprovacao' });
    await db.insert(jobEvents).values({ jobId: job.id, fromColumn: 'aplicada', toColumn: 'perdida', actor: 'email', mailMessageId: id, createdAt: NOW });

    expect((await get('/email/messages')).json()[0]).toMatchObject({ movedTo: 'perdida', canUndoMove: true });
    expect((await post(`/email/messages/${id}/undo-move`)).statusCode).toBe(200);
    const second = await post(`/email/messages/${id}/undo-move`);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'cannot_undo' });
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.column).toBe('aplicada');
    expect((await get('/email/messages')).json()[0]).toMatchObject({ movedTo: 'perdida', canUndoMove: false, corrected: true });
    expect((await post('/email/messages/999/undo-move')).statusCode).toBe(404);
  });
});

describe('ignored mail', () => {
  it('lists ignored mail and asks the worker to keep one', async () => {
    await insertIgnored(db, {
      messageId: '<i@globex.example>', uid: 7, fromAddress: 'news@globex.example', fromName: 'Globex', subject: 'Novidades',
      sentAt: NOW, company: 'Globex',
    }, NOW);
    const [item] = (await get('/email/ignored')).json();
    expect(item).toMatchObject({ subject: 'Novidades', promoted: false });
    expect((await post(`/email/ignored/${item.id}/promote`)).statusCode).toBe(200);
    expect((await get('/email/ignored')).json()[0]).toMatchObject({ promoted: true });
    expect((await post('/email/ignored/999/promote')).statusCode).toBe(404);
  });
});

describe('replies', () => {
  it('edits and approves a draft, and refuses one with a gap', async () => {
    const job = await seedJob(db);
    const replyId = await draftFor(await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'entrevista' }));
    const refused = await post(`/email/replies/${replyId}/approve`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'draft_has_gaps' });
    expect((await replyById(db, replyId))!.state).toBe('rascunho');

    const edited = await patch(`/email/replies/${replyId}`, { body: 'Posso na terça, às 10h.\n\nMaria Exemplo da Silva' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ id: replyId, body: 'Posso na terça, às 10h.\n\nMaria Exemplo da Silva', state: 'rascunho' });
    expect((await post(`/email/replies/${replyId}/approve`)).statusCode).toBe(200);
    expect((await replyById(db, replyId))!).toMatchObject({ state: 'aprovada', approvedBy: 'owner' });
  });

  it('does not edit or approve a reply that left the draft state', async () => {
    const replyId = await sentReplyFor(await seedMail({ kind: 'pedido' }));
    const edit = await patch(`/email/replies/${replyId}`, { body: 'Outro texto.' });
    expect(edit.statusCode).toBe(409);
    expect(edit.json()).toMatchObject({ error: 'not_a_draft' });
    const approve = await post(`/email/replies/${replyId}/approve`);
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toMatchObject({ error: 'wrong_state' });
    expect((await replyById(db, replyId))!).toMatchObject({ state: 'enviada', body: 'Meu telefone.' });
  });

  it('refuses an empty edit and unknown replies', async () => {
    const replyId = await draftFor(await seedMail({ kind: 'entrevista' }));
    expect((await patch(`/email/replies/${replyId}`, { body: '   ' })).statusCode).toBe(400);
    expect((await patch('/email/replies/999', { body: 'Texto.' })).statusCode).toBe(404);
    expect((await post('/email/replies/999/approve')).statusCode).toBe(404);
    expect((await post('/email/replies/999/discard')).statusCode).toBe(404);
  });

  it('discarding a draft clears its alerts', async () => {
    const job = await seedJob(db);
    const messageId = await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'entrevista' });
    const replyId = await draftFor(messageId);
    await raiseAlert(db, { kind: 'interview', jobId: job.id, mailMessageId: messageId, replyId }, NOW);
    expect((await get('/alerts')).json().alerts).toHaveLength(1);

    expect((await post(`/email/replies/${replyId}/discard`)).statusCode).toBe(200);
    expect((await get('/alerts')).json().alerts).toEqual([]);
    expect((await replyById(db, replyId))!.state).toBe('descartada');
    expect((await post(`/email/replies/${replyId}/discard`)).json()).toMatchObject({ error: 'wrong_state' });
  });

  it('approving a draft clears the alert that asked for it', async () => {
    const replyId = await draftFor(await seedMail({ kind: 'entrevista' }), 'Posso na terça.');
    await raiseAlert(db, { kind: 'draft', replyId }, NOW);
    expect((await post(`/email/replies/${replyId}/approve`)).statusCode).toBe(200);
    expect((await get('/alerts')).json().alerts).toEqual([]);
  });
});

describe('alerts', () => {
  it('lists the open alerts', async () => {
    const job = await seedJob(db, { company: 'Acme' });
    const messageId = await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'oferta', subject: 'Proposta' });
    await raiseAlert(db, { kind: 'offer', jobId: job.id, mailMessageId: messageId }, NOW);
    expect((await get('/alerts')).json()).toEqual({
      alerts: [expect.objectContaining({ kind: 'offer', company: 'Acme', subject: 'Proposta', messageId, jobId: job.id })],
    });
  });

  it('dismisses an alert once', async () => {
    const alertId = (await raiseAlert(db, { kind: 'offer', mailMessageId: await seedMail({ kind: 'oferta' }) }, NOW))!;
    expect((await post(`/alerts/${alertId}/dismiss`)).statusCode).toBe(200);
    expect((await get('/alerts')).json().alerts).toEqual([]);
    expect((await post(`/alerts/${alertId}/dismiss`)).json()).toMatchObject({ error: 'alert_closed' });
    expect((await post('/alerts/999/dismiss')).statusCode).toBe(404);
  });

  it('confirms or declines a pending move', async () => {
    const job = await seedJob(db, { column: 'aplicada' });
    const accepted = await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'reprovacao' });
    const alertId = (await raiseAlert(db, { kind: 'move_confirm', jobId: job.id, mailMessageId: accepted, payload: { moveTo: 'perdida' } }, NOW))!;
    const res = await post(`/alerts/${alertId}/move`, { accept: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ moved: true });
    const column = async () => (await db.select().from(jobs).where(eq(jobs.id, job.id)))[0].column;
    expect(await column()).toBe('perdida');
    const [event] = await db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id));
    expect(event).toMatchObject({ actor: 'email', mailMessageId: accepted, fromColumn: 'aplicada', toColumn: 'perdida' });
    expect((await get('/alerts')).json().alerts).toEqual([]);
    // Uma segunda resposta ao mesmo alerta não move de novo.
    expect((await post(`/alerts/${alertId}/move`, { accept: true })).statusCode).toBe(409);

    const declined = await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'entrevista' });
    const other = (await raiseAlert(db, { kind: 'move_confirm', jobId: job.id, mailMessageId: declined, payload: { moveTo: 'entrevista' } }, NOW))!;
    expect((await post(`/alerts/${other}/move`, { accept: false })).json()).toEqual({ moved: false });
    expect(await column()).toBe('perdida');
    expect((await get('/alerts')).json().alerts).toEqual([]);
  });

  it('resolves a confirmed move even when the card cannot move', async () => {
    const job = await seedJob(db, { column: 'arquivada' });
    const messageId = await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'reprovacao' });
    const alertId = (await raiseAlert(db, { kind: 'move_confirm', jobId: job.id, mailMessageId: messageId, payload: { moveTo: 'perdida' } }, NOW))!;
    expect((await post(`/alerts/${alertId}/move`, { accept: true })).json()).toEqual({ moved: false });
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0].column).toBe('arquivada');
    expect((await alertById(db, alertId))!.resolvedAt).toBe(NOW);
  });

  it('retries a request once the missing answer is saved', async () => {
    const messageId = await seedMail({ kind: 'pedido' });
    const alertId = (await raiseAlert(db, { kind: 'missing_fact', mailMessageId: messageId, payload: { missing: ['salary'] } }, NOW))!;
    expect((await post(`/alerts/${alertId}/retry`)).statusCode).toBe(200);
    expect((await mailMessageById(db, messageId))!.processedAt).toBeNull();
    expect((await get('/alerts')).json().alerts).toEqual([]);
  });

  it('releases mail held by the daily limit', async () => {
    const waiting = await seedMail({ kind: null, processed: false });
    const done = await seedMail({ kind: 'recebimento' });
    const alertId = (await raiseAlert(db, { kind: 'budget_waiting', payload: { waiting: 1 } }, NOW))!;
    const res = await post(`/alerts/${alertId}/classify-anyway`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ released: 1 });
    expect((await mailMessageById(db, waiting))!.forceClassify).toBe(true);
    expect((await mailMessageById(db, done))!.forceClassify).toBe(false);
    expect((await get('/alerts')).json().alerts).toEqual([]);
  });

  it('refuses an action on an alert of another kind', async () => {
    const job = await seedJob(db, { column: 'entrevista' });
    const messageId = await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'oferta' });
    const alertId = (await raiseAlert(db, { kind: 'offer', jobId: job.id, mailMessageId: messageId, payload: { moveTo: 'oferta' } }, NOW))!;
    for (const action of ['move', 'retry', 'classify-anyway']) {
      const res = await post(`/alerts/${alertId}/${action}`, action === 'move' ? { accept: true } : undefined);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'wrong_kind' });
    }
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0].column).toBe('entrevista');
    expect((await get('/alerts')).json().alerts).toHaveLength(1);
    expect((await post('/alerts/999/move', { accept: true })).statusCode).toBe(404);
  });

  it('refuses changes off a local host and still answers reads', async () => {
    const job = await seedJob(db);
    const messageId = await seedMail({ kind: 'entrevista' });
    const replyId = await draftFor(messageId, 'Posso na terça.');
    const alertId = (await raiseAlert(db, { kind: 'unmatched', mailMessageId: messageId }, NOW))!;
    vi.stubEnv('HOST', '0.0.0.0');
    const changes = [
      post(`/email/messages/${messageId}/link`, { jobId: job.id }),
      post(`/email/messages/${messageId}/unlink`),
      post(`/email/messages/${messageId}/undo-move`),
      post('/email/ignored/1/promote'),
      patch(`/email/replies/${replyId}`, { body: 'Outro.' }),
      post(`/email/replies/${replyId}/approve`),
      post(`/email/replies/${replyId}/discard`),
      post(`/alerts/${alertId}/dismiss`),
      post(`/alerts/${alertId}/move`, { accept: true }),
      post(`/alerts/${alertId}/retry`),
      post(`/alerts/${alertId}/classify-anyway`),
    ];
    for (const res of await Promise.all(changes)) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'email_unavailable', message: expect.stringContaining('endereço local') });
    }
    for (const url of ['/alerts', '/email/messages', '/email/ignored', `/jobs/${job.id}/emails`]) expect((await get(url)).statusCode).toBe(200);
    expect((await replyById(db, replyId))!).toMatchObject({ state: 'rascunho', body: 'Posso na terça.' });
    expect((await get('/alerts')).json().alerts).toHaveLength(1);
  });
});

describe('mail marks on the board', () => {
  it('carries the mail marks on the board and the mail on the card history', async () => {
    const job = await seedJob(db, { column: 'entrevista' });
    const other = await seedJob(db);
    await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'recebimento' });
    const invite = await seedMail({ jobId: job.id, linkedBy: 'auto', kind: 'entrevista', subject: 'Convite para entrevista' });
    await db.insert(jobEvents).values([
      { jobId: job.id, fromColumn: null, toColumn: 'aplicada', actor: 'humano', createdAt: NOW - 5000 },
      { jobId: job.id, fromColumn: 'aplicada', toColumn: 'entrevista', actor: 'email', mailMessageId: invite, createdAt: NOW },
    ]);
    await raiseAlert(db, { kind: 'interview', jobId: job.id, mailMessageId: invite }, NOW);

    const board = (await get('/jobs')).json();
    expect(board.find((j: { id: number }) => j.id === job.id).mail).toEqual({ confirmed: true, badge: 'entrevista' });
    expect(board.find((j: { id: number }) => j.id === other.id).mail).toEqual({ confirmed: false, badge: null });
    const detail = (await get(`/jobs/${job.id}`)).json();
    expect(detail.job.mail).toEqual({ confirmed: true, badge: 'entrevista' });
    expect(detail.events[0]).toMatchObject({ actor: 'humano', mail: null });
    expect(detail.events.at(-1)).toMatchObject({ actor: 'email', mail: { kind: 'entrevista', subject: 'Convite para entrevista' } });
    const patched = (await patch(`/jobs/${other.id}`, { notes: 'n' })).json();
    expect(patched.mail).toEqual({ confirmed: false, badge: null });
  });
});
