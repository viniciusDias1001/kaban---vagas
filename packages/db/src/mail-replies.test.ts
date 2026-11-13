import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './index';
import {
  approveReply, createReply, discardReply, editReply, markReplyFailed, markReplySending, markReplySent, nextApprovedReply,
  replyById, replyForMessage, repliesInSending, returnReplyToDraft, toMailReplyDto, type NewReply,
} from './mail-replies';
import { mailMessages } from './schema';
import { createTestDb, resetTestDb } from './testing';

let db: Db;
let messageId: number;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  messageId = await seedMessage('<pedido-1@acme.example>');
});
afterAll(() => closeDb(db));

async function seedMessage(id: string): Promise<number> {
  const [row] = await db
    .insert(mailMessages)
    .values({
      messageId: id, threadKey: id, direction: 'in', fromAddress: 'rh@acme.example', fromName: 'RH Acme', toAddress: 'maria@example.com',
      subject: 'Seus dados', body: 'Pode mandar seu telefone?', sentAt: 500, createdAt: 500, kind: 'pedido',
    })
    .returning({ id: mailMessages.id });
  return row.id;
}

const reply = (over: Partial<NewReply> & Pick<NewReply, 'messageId' | 'state'>): NewReply => ({
  origin: 'facts', items: ['phone'], toAddress: 'rh@acme.example', subject: 'Re: Seus dados', body: 'Olá, meu telefone é ...',
  attachResume: false, ...over,
});

describe('mail replies', () => {
  it('allows one reply per message', async () => {
    expect(await createReply(db, reply({ messageId, state: 'rascunho' }), 1000)).toEqual(expect.any(Number));
    expect(await createReply(db, reply({ messageId, state: 'rascunho' }), 1001)).toBeNull();
    expect((await replyForMessage(db, messageId))!).toMatchObject({ state: 'rascunho', createdAt: 1000, approvedAt: null });
  });

  it('records the approval of a reply created already approved', async () => {
    const id = (await createReply(db, reply({ messageId, state: 'aprovada', approvedBy: 'auto' }), 1000))!;
    expect((await replyById(db, id))!).toMatchObject({ state: 'aprovada', approvedBy: 'auto', approvedAt: 1000 });
    expect(await replyById(db, id + 1)).toBeNull();
    expect(await replyForMessage(db, messageId + 1)).toBeNull();
  });

  it('moves to sending only once', async () => {
    const id = (await createReply(db, reply({ messageId, state: 'rascunho' }), 1000))!;
    expect(await markReplySending(db, id, 'out-0@kv', 1500)).toBe(false); // ainda é rascunho
    await approveReply(db, id, 'owner', 2000);
    expect(await markReplySending(db, id, 'out-1@kv', 3000)).toBe(true);
    expect(await markReplySending(db, id, 'out-2@kv', 3001)).toBe(false);
    expect((await replyById(db, id))!).toMatchObject({ state: 'enviando', outMessageId: 'out-1@kv', approvedBy: 'owner', approvedAt: 2000 });
    expect((await repliesInSending(db)).map((r) => r.id)).toEqual([id]);

    await markReplySent(db, id, 4000);
    expect((await replyById(db, id))!).toMatchObject({ state: 'enviada', sentAt: 4000 });
    expect(await repliesInSending(db)).toEqual([]);
    await markReplyFailed(db, id, 'tarde demais', 4001); // só sai de `enviando`
    expect((await replyById(db, id))!).toMatchObject({ state: 'enviada', note: null });
  });

  it('edits only a draft and never approves a sent reply', async () => {
    const id = (await createReply(db, reply({ messageId, state: 'rascunho' }), 1000))!;
    expect(await editReply(db, id, 'Texto novo')).toBe(true);
    expect((await replyById(db, id))!.body).toBe('Texto novo');

    expect(await approveReply(db, id, 'owner', 2000)).toBe(true);
    expect(await editReply(db, id, 'Outro texto')).toBe(false);
    expect(await markReplySending(db, id, 'out-1@kv', 3000)).toBe(true);
    await markReplySent(db, id, 3500);
    expect(await approveReply(db, id, 'owner', 4000)).toBe(false);
    expect(await discardReply(db, id, 'não', 4000)).toBe(false);
    expect((await replyById(db, id))!).toMatchObject({ state: 'enviada', body: 'Texto novo' });

    const other = await seedMessage('<pedido-2@acme.example>');
    const discarded = (await createReply(db, reply({ messageId: other, state: 'rascunho' }), 1000))!;
    expect(await discardReply(db, discarded, 'Já respondi por telefone', 2000)).toBe(true);
    expect(await approveReply(db, discarded, 'owner', 3000)).toBe(false);
    expect(await editReply(db, discarded, 'x')).toBe(false);
    expect((await replyById(db, discarded))!).toMatchObject({ state: 'descartada', note: 'Já respondi por telefone' });
  });

  it('approves a failed reply again and discards it', async () => {
    const id = (await createReply(db, reply({ messageId, state: 'aprovada', approvedBy: 'auto' }), 1000))!;
    expect(await markReplySending(db, id, 'out-1@kv', 2000)).toBe(true);
    await markReplyFailed(db, id, 'SMTP recusou', 2100);
    expect((await replyById(db, id))!).toMatchObject({ state: 'falhou', note: 'SMTP recusou' });
    expect(await approveReply(db, id, 'owner', 3000)).toBe(true);
    expect((await replyById(db, id))!).toMatchObject({ state: 'aprovada', approvedBy: 'owner', approvedAt: 3000 });
    expect(await discardReply(db, id, null, 3100)).toBe(true);
    expect((await replyById(db, id))!.state).toBe('descartada');
  });

  it('returns an interrupted send to the owner', async () => {
    const id = (await createReply(db, reply({ messageId, state: 'aprovada', approvedBy: 'auto' }), 1000))!;
    expect(await markReplySending(db, id, 'out-1@kv', 2000)).toBe(true);
    await returnReplyToDraft(db, id, 'O envio foi interrompido: confira antes de mandar de novo.');
    expect((await replyById(db, id))!).toMatchObject({
      state: 'rascunho', note: 'O envio foi interrompido: confira antes de mandar de novo.', outMessageId: 'out-1@kv', approvedBy: null, approvedAt: null,
    });
    await markReplySent(db, id, 3000); // não está mais em `enviando`
    expect((await replyById(db, id))!.state).toBe('rascunho');
  });

  it('hands out the oldest approved reply', async () => {
    const second = await seedMessage('<pedido-2@acme.example>');
    const a = (await createReply(db, reply({ messageId, state: 'rascunho' }), 1000))!;
    const b = (await createReply(db, reply({ messageId: second, state: 'aprovada', approvedBy: 'auto' }), 1100))!;
    expect((await nextApprovedReply(db))!.id).toBe(b);
    await approveReply(db, a, 'owner', 1050);
    expect((await nextApprovedReply(db))!.id).toBe(a);
    await markReplySending(db, a, 'out-a@kv', 1200);
    await markReplySending(db, b, 'out-b@kv', 1200);
    expect(await nextApprovedReply(db)).toBeNull();
  });

  it('turns a row into the DTO the screens use', async () => {
    const id = (await createReply(db, reply({ messageId, state: 'rascunho', note: 'Falta conferir', attachResume: true }), 1000))!;
    expect(toMailReplyDto((await replyById(db, id))!)).toEqual({
      id, messageId, origin: 'facts', items: ['phone'], toAddress: 'rh@acme.example', subject: 'Re: Seus dados', body: 'Olá, meu telefone é ...',
      attachResume: true, state: 'rascunho', note: 'Falta conferir', createdAt: 1000, sentAt: null,
    });
  });
});
