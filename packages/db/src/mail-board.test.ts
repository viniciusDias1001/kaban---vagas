import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import type { Column } from '@kv/shared';
import { deleteAllAiData } from './ai';
import { appliedJobFacts } from './dashboard';
import { closeDb, type Db } from './index';
import { raiseAlert } from './mail-alerts';
import { deleteMailData, moveCardByEmail, moveStateFor, undoEmailMove } from './mail-board';
import { createReply } from './mail-replies';
import { alerts, appSecrets, jobEvents, jobs, mailAccount, mailIgnored, mailMessages, mailReplies } from './schema';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function seedJob(externalId: string, column: Column, position = 1): Promise<number> {
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId, url: `https://example.com/${externalId}`, title: 'Dev', company: 'Acme', location: 'Remoto', country: 'BR',
      remote: true, level: null, stacks: [], description: '', postedAt: null, discoveredAt: 1, dedupHash: externalId, profileId: null,
      position, column,
    })
    .returning({ id: jobs.id });
  return row.id;
}

async function seedMessage(id: string, jobId: number | null, sentAt: number): Promise<number> {
  const [row] = await db
    .insert(mailMessages)
    .values({
      messageId: id, threadKey: id, direction: 'in', fromAddress: 'rh@acme.example', fromName: 'RH Acme', toAddress: 'maria@example.com',
      subject: 'Convite', body: 'Olá', sentAt, createdAt: sentAt, kind: 'entrevista', jobId,
    })
    .returning({ id: mailMessages.id });
  return row.id;
}

const job = async (id: number) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];
const events = (jobId: number) => db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(desc(jobEvents.id));
const message = async (id: number) => (await db.select().from(mailMessages).where(eq(mailMessages.id, id)))[0];

describe('card moves by e-mail', () => {
  it('moves backwards when the mail says so and records who did it', async () => {
    const jobId = await seedJob('a', 'perdida');
    await seedJob('b', 'entrevista', 3);
    const messageId = await seedMessage('<i@acme.example>', jobId, 4000);
    expect(await moveCardByEmail(db, { jobId, to: 'entrevista', messageId }, 5000)).toBe(true);
    const [lastEvent] = await events(jobId);
    expect(lastEvent).toMatchObject({ fromColumn: 'perdida', toColumn: 'entrevista', actor: 'email', mailMessageId: messageId, createdAt: 5000 });
    // Topo da coluna: acima do card que já estava lá.
    expect(await job(jobId)).toMatchObject({ column: 'entrevista', position: 2 });
  });

  it('does nothing when the card is already in the column', async () => {
    const jobId = await seedJob('a', 'entrevista');
    const messageId = await seedMessage('<i@acme.example>', jobId, 4000);
    expect(await moveCardByEmail(db, { jobId, to: 'entrevista', messageId }, 5000)).toBe(false);
    expect(await events(jobId)).toEqual([]);
    expect(await moveCardByEmail(db, { jobId: jobId + 100, to: 'oferta', messageId }, 5000)).toBe(false);
  });

  it('never moves an archived card', async () => {
    const jobId = await seedJob('a', 'arquivada');
    const messageId = await seedMessage('<i@acme.example>', jobId, 4000);
    expect(await moveCardByEmail(db, { jobId, to: 'entrevista', messageId }, 5000)).toBe(false);
    expect(await events(jobId)).toEqual([]);
    expect((await job(jobId)).column).toBe('arquivada');
  });

  it('reports the state decideMove needs', async () => {
    const jobId = await seedJob('a', 'aplicada');
    expect(await moveStateFor(db, jobId)).toEqual({ column: 'aplicada', lastMove: null, lastDecisiveMailAt: null });
    await db.insert(jobEvents).values({ jobId, fromColumn: 'selecionadas', toColumn: 'aplicada', actor: 'ia', createdAt: 3000 });
    expect(await moveStateFor(db, jobId)).toEqual({ column: 'aplicada', lastMove: { actor: 'ia', at: 3000 }, lastDecisiveMailAt: null });

    const older = await seedMessage('<r@acme.example>', jobId, 3500);
    const mailSentAt = 4000;
    const messageId = await seedMessage('<i@acme.example>', jobId, mailSentAt);
    await moveCardByEmail(db, { jobId, to: 'perdida', messageId: older }, 4500);
    await moveCardByEmail(db, { jobId, to: 'entrevista', messageId }, 5000);
    expect(await moveStateFor(db, jobId)).toEqual({ column: 'entrevista', lastMove: { actor: 'email', at: 5000 }, lastDecisiveMailAt: mailSentAt });
    expect(await moveStateFor(db, jobId + 100)).toBeNull();
  });

  it('undoes only the latest move of the card', async () => {
    const jobId = await seedJob('a', 'perdida');
    await seedJob('b', 'perdida', 7);
    const messageId = await seedMessage('<i@acme.example>', jobId, 4000);
    await moveCardByEmail(db, { jobId, to: 'entrevista', messageId }, 5000);

    expect(await undoEmailMove(db, messageId, 6000)).toBe(true); // volta a 'perdida', evento 'humano', mensagem corrected
    expect(await job(jobId)).toMatchObject({ column: 'perdida', position: 6 });
    expect((await events(jobId))[0]).toMatchObject({ fromColumn: 'entrevista', toColumn: 'perdida', actor: 'humano', mailMessageId: null, createdAt: 6000 });
    expect((await message(messageId)).corrected).toBe(true);
    expect(await undoEmailMove(db, messageId, 6001)).toBe(false);
    expect(await events(jobId)).toHaveLength(2);

    // com um movimento do dono depois do e-mail: false e o card não muda
    const other = await seedJob('c', 'aplicada');
    const invite = await seedMessage('<i@globex.example>', other, 4000);
    await moveCardByEmail(db, { jobId: other, to: 'entrevista', messageId: invite }, 5000);
    await db.update(jobs).set({ column: 'oferta' }).where(eq(jobs.id, other));
    await db.insert(jobEvents).values({ jobId: other, fromColumn: 'entrevista', toColumn: 'oferta', actor: 'humano', createdAt: 5500 });
    expect(await undoEmailMove(db, invite, 6000)).toBe(false);
    expect((await job(other)).column).toBe('oferta');
    expect((await message(invite)).corrected).toBe(false);

    // mensagem que não moveu nada
    expect(await undoEmailMove(db, await seedMessage('<x@acme.example>', jobId, 4000), 6000)).toBe(false);
  });
});

describe('mail data deletion', () => {
  it('deletes mail data and keeps the mailbox', async () => {
    const jobId = await seedJob('a', 'aplicada');
    await db.insert(mailAccount).values({ id: 1, address: 'maria@example.com', connectedAt: 1000 });
    await db.insert(appSecrets).values({ name: 'mail_password', sealed: Buffer.from('opaco'), updatedAt: 1000 });
    const messageId = await seedMessage('<i@acme.example>', jobId, 4000);
    await createReply(db, {
      messageId, origin: 'ai', items: [], toAddress: 'rh@acme.example', subject: 'Re: Convite', body: 'Olá', attachResume: false, state: 'rascunho',
    }, 1000);
    await raiseAlert(db, { kind: 'interview', jobId, mailMessageId: messageId }, 1000);
    await raiseAlert(db, { kind: 'mailbox_error', payload: { reason: 'Senha recusada' } }, 1000);
    await db.insert(mailIgnored).values({
      messageId: '<news@globex.example>', uid: 9, fromAddress: 'news@globex.example', fromName: 'Globex', subject: 'Novidades', company: 'Globex',
      sentAt: 1000, createdAt: 1000,
    });
    await moveCardByEmail(db, { jobId, to: 'entrevista', messageId }, 5000);

    await deleteAllAiData(db);
    expect(await db.select().from(mailMessages)).toEqual([]);
    expect(await db.select().from(mailReplies)).toEqual([]);
    expect(await db.select().from(mailIgnored)).toEqual([]);
    expect(await db.select().from(alerts)).toEqual([]);
    expect(await db.select().from(mailAccount)).toHaveLength(1);
    expect(await db.select().from(appSecrets)).toHaveLength(1);
    // O histórico do card fica, sem a ligação com o e-mail apagado.
    expect(await events(jobId)).toEqual([expect.objectContaining({ actor: 'email', toColumn: 'entrevista', mailMessageId: null })]);
  });

  it('keeps an undone move out of the Painel after the mail is deleted', async () => {
    const jobId = await seedJob('a', 'aplicada');
    await db.insert(jobEvents).values({ jobId, fromColumn: 'selecionadas', toColumn: 'aplicada', actor: 'humano', createdAt: 1000 });
    const rejection = await seedMessage('<r@acme.example>', jobId, 4000);
    await db.update(mailMessages).set({ kind: 'reprovacao' }).where(eq(mailMessages.id, rejection));
    await moveCardByEmail(db, { jobId, to: 'perdida', messageId: rejection }, 5000);
    expect(await undoEmailMove(db, rejection, 6000)).toBe(true);
    expect((await events(jobId)).find((e) => e.actor === 'email')).toMatchObject({ undone: true });

    await deleteMailData(db);
    expect(await appliedJobFacts(db, null)).toEqual([
      expect.objectContaining({ jobId, column: 'aplicada', appliedAt: 1000, firstResponseAt: null, lostAt: null }),
    ]);
  });

  it('can run inside a transaction of the caller', async () => {
    await seedMessage('<i@acme.example>', null, 4000);
    await db.transaction((tx) => deleteMailData(tx));
    expect(await db.select().from(mailMessages)).toEqual([]);
  });
});
