import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './index';
import {
  alertById, dismissAlert, mailMarksForJobs, markPhoneAttempt, nextPhoneAlert, openAlerts, raiseAlert, resolveAlerts,
} from './mail-alerts';
import { alerts, jobs, mailMessages, mailReplies } from './schema';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function seedJob(externalId: string, company: string, title: string): Promise<number> {
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId, url: `https://example.com/${externalId}`, title, company, location: 'Remoto', country: 'BR',
      remote: true, level: null, stacks: [], description: '', postedAt: null, discoveredAt: 1, dedupHash: externalId, profileId: null,
      position: 1, column: 'aplicada',
    })
    .returning({ id: jobs.id });
  return row.id;
}

async function seedMessage(
  id: string, jobId: number | null, kind: typeof mailMessages.$inferInsert.kind, summary: string | null = null,
): Promise<number> {
  const [row] = await db
    .insert(mailMessages)
    .values({
      messageId: id, threadKey: id, direction: 'in', fromAddress: 'rh@acme.example', fromName: 'RH Acme', toAddress: 'maria@example.com',
      subject: `Assunto ${id}`, body: 'Olá', sentAt: 500, createdAt: 500, kind, summary, jobId,
    })
    .returning({ id: mailMessages.id });
  return row.id;
}

describe('alerts', () => {
  it('keeps one open alert per kind and message', async () => {
    const jobId = await seedJob('a', 'Acme', 'Dev');
    const mailMessageId = await seedMessage('<m1@acme.example>', jobId, 'entrevista');
    const id = await raiseAlert(db, { kind: 'interview', jobId, mailMessageId }, 1000);
    expect(id).toEqual(expect.any(Number));
    expect(await raiseAlert(db, { kind: 'interview', jobId, mailMessageId }, 1001)).toBeNull();
    // Outro tipo para a mesma mensagem é outro alerta.
    expect(await raiseAlert(db, { kind: 'draft', jobId, mailMessageId }, 1002)).toEqual(expect.any(Number));
    // Depois de resolvido, um novo pode abrir.
    expect(await resolveAlerts(db, { kind: 'interview', mailMessageId }, 1100)).toBe(1);
    expect(await raiseAlert(db, { kind: 'interview', jobId, mailMessageId }, 1200)).toEqual(expect.any(Number));
    expect((await alertById(db, id!))!).toMatchObject({ resolvedAt: 1100, dismissedAt: null });
    expect(await alertById(db, 999)).toBeNull();
  });

  it('keeps one open alert per kind and effective message when the alert names only the reply', async () => {
    const jobId = await seedJob('a', 'Acme', 'Dev');
    const m1 = await seedMessage('<p1@acme.example>', jobId, 'pedido');
    const m2 = await seedMessage('<p2@acme.example>', jobId, 'pedido');
    const [r1, r2] = await db
      .insert(mailReplies)
      .values([
        { messageId: m1, origin: 'ai', toAddress: 'rh@acme.example', subject: 'Re', body: 'Olá', state: 'rascunho', createdAt: 1000 },
        { messageId: m2, origin: 'ai', toAddress: 'rh@acme.example', subject: 'Re', body: 'Olá', state: 'rascunho', createdAt: 1000 },
      ])
      .returning({ id: mailReplies.id });
    expect(await raiseAlert(db, { kind: 'draft', replyId: r1.id }, 1000)).toEqual(expect.any(Number));
    expect(await raiseAlert(db, { kind: 'draft', replyId: r2.id }, 1001)).toEqual(expect.any(Number));
    // A mesma mensagem, pela resposta ou pela própria mensagem, já tem o alerta.
    expect(await raiseAlert(db, { kind: 'draft', replyId: r1.id }, 1002)).toBeNull();
    expect(await raiseAlert(db, { kind: 'draft', jobId, mailMessageId: m2 }, 1003)).toBeNull();
    expect((await openAlerts(db)).map((a) => a.messageId).sort()).toEqual([m1, m2].sort());
  });

  it('keeps one open alert per kind and card when there is neither message nor reply', async () => {
    const jobA = await seedJob('a', 'Acme', 'Dev');
    const jobB = await seedJob('b', 'Globex', 'Dev');
    expect(await raiseAlert(db, { kind: 'move_confirm', jobId: jobA, payload: { moveTo: 'entrevista' } }, 1000)).toEqual(expect.any(Number));
    expect(await raiseAlert(db, { kind: 'move_confirm', jobId: jobB, payload: { moveTo: 'oferta' } }, 1001)).toEqual(expect.any(Number));
    expect(await raiseAlert(db, { kind: 'move_confirm', jobId: jobA, payload: { moveTo: 'oferta' } }, 1002)).toBeNull();
    expect(await openAlerts(db)).toHaveLength(2);
  });

  it('updates the single mailbox-level alert instead of stacking', async () => {
    expect(await raiseAlert(db, { kind: 'budget_waiting', payload: { waiting: 2 } }, 1000)).toEqual(expect.any(Number));
    expect(await raiseAlert(db, { kind: 'budget_waiting', payload: { waiting: 5 } }, 1001)).toBeNull();
    expect((await openAlerts(db)).filter((a) => a.kind === 'budget_waiting')).toEqual([expect.objectContaining({ payload: { waiting: 5 } })]);
    await raiseAlert(db, { kind: 'mailbox_error', payload: { reason: 'Senha recusada' } }, 1002);
    expect((await openAlerts(db)).map((a) => a.kind)).toEqual(['mailbox_error', 'budget_waiting']);
  });

  it('lists open alerts newest first with the card and the mail', async () => {
    const jobId = await seedJob('a', 'Acme', 'Dev Backend');
    const m1 = await seedMessage('<m1@acme.example>', jobId, 'entrevista', 'Convite para conversa na terça');
    const m2 = await seedMessage('<m2@acme.example>', jobId, 'pedido', 'Pediu o telefone');
    const m3 = await seedMessage('<m3@globex.example>', null, 'outro');
    const [reply] = await db
      .insert(mailReplies)
      .values({ messageId: m2, origin: 'ai', toAddress: 'rh@acme.example', subject: 'Re', body: 'Olá', state: 'rascunho', createdAt: 1000 })
      .returning({ id: mailReplies.id });

    const interview = (await raiseAlert(db, { kind: 'interview', jobId, mailMessageId: m1 }, 1000))!;
    const draft = (await raiseAlert(db, { kind: 'draft', replyId: reply.id }, 2000))!;
    const resolved = (await raiseAlert(db, { kind: 'unmatched', mailMessageId: m3 }, 3000))!;
    const dismissed = (await raiseAlert(db, { kind: 'offer', jobId, mailMessageId: m1 }, 4000))!;
    await resolveAlerts(db, { mailMessageId: m3 }, 5000);
    expect(await dismissAlert(db, dismissed, 5000)).toBe(true);
    expect(await dismissAlert(db, dismissed, 5001)).toBe(false);
    expect(await dismissAlert(db, resolved, 5001)).toBe(false);

    expect(await openAlerts(db)).toEqual([
      {
        id: draft, kind: 'draft', jobId, company: 'Acme', jobTitle: 'Dev Backend', messageId: m2, replyId: reply.id,
        subject: 'Assunto <m2@acme.example>', summary: 'Pediu o telefone', payload: {}, createdAt: 2000,
      },
      {
        id: interview, kind: 'interview', jobId, company: 'Acme', jobTitle: 'Dev Backend', messageId: m1, replyId: null,
        subject: 'Assunto <m1@acme.example>', summary: 'Convite para conversa na terça', payload: {}, createdAt: 1000,
      },
    ]);
  });

  it('resolves only what the filter names', async () => {
    const jobId = await seedJob('a', 'Acme', 'Dev');
    const m1 = await seedMessage('<m1@acme.example>', jobId, 'entrevista');
    const m2 = await seedMessage('<m2@acme.example>', jobId, 'oferta');
    await raiseAlert(db, { kind: 'interview', jobId, mailMessageId: m1 }, 1000);
    await raiseAlert(db, { kind: 'offer', jobId, mailMessageId: m2 }, 1000);
    expect(await resolveAlerts(db, {}, 2000)).toBe(0);
    expect(await resolveAlerts(db, { kind: 'interview', mailMessageId: m2 }, 2000)).toBe(0);
    expect(await resolveAlerts(db, { mailMessageId: m2 }, 2000)).toBe(1);
    expect(await resolveAlerts(db, { mailMessageId: m2 }, 2001)).toBe(0);
    expect((await openAlerts(db)).map((a) => a.kind)).toEqual(['interview']);
  });

  it('derives the card marks', async () => {
    // vaga A: e-mail 'recebimento' e alerta interview aberto; vaga B: alerta offer dispensado
    const jobA = await seedJob('a', 'Acme', 'Dev');
    const jobB = await seedJob('b', 'Globex', 'Dev');
    await seedMessage('<r@acme.example>', jobA, 'recebimento');
    const invite = await seedMessage('<i@acme.example>', jobA, 'entrevista');
    const offer = await seedMessage('<o@globex.example>', jobB, 'oferta');
    await raiseAlert(db, { kind: 'interview', jobId: jobA, mailMessageId: invite }, 1000);
    await dismissAlert(db, (await raiseAlert(db, { kind: 'offer', jobId: jobB, mailMessageId: offer }, 1000))!, 1100);
    expect(await mailMarksForJobs(db)).toEqual(new Map([[jobA, { confirmed: true, badge: 'entrevista' }]]));
  });

  it('marks a request that waits for the owner and keeps the badge priority', async () => {
    const jobA = await seedJob('a', 'Acme', 'Dev');
    const jobB = await seedJob('b', 'Globex', 'Dev');
    const jobC = await seedJob('c', 'Initech', 'Dev');
    const askA = await seedMessage('<p@acme.example>', jobA, 'pedido');
    const inviteB = await seedMessage('<i@globex.example>', jobB, 'entrevista');
    const offerA = await seedMessage('<o@acme.example>', jobA, 'oferta');
    const askC = await seedMessage('<p@initech.example>', jobC, 'pedido');
    await raiseAlert(db, { kind: 'missing_fact', jobId: jobA, mailMessageId: askA, payload: { missing: ['salary'] } }, 1000);
    // Rascunho de um convite não é "pedido".
    await raiseAlert(db, { kind: 'draft', jobId: jobB, mailMessageId: inviteB }, 1000);
    // Rascunho de um pedido é.
    await raiseAlert(db, { kind: 'draft', jobId: jobC, mailMessageId: askC }, 1000);
    expect(await mailMarksForJobs(db)).toEqual(
      new Map([
        [jobA, { confirmed: false, badge: 'pedido' }],
        [jobC, { confirmed: false, badge: 'pedido' }],
      ]),
    );
    await raiseAlert(db, { kind: 'offer', jobId: jobA, mailMessageId: offerA }, 1100);
    expect((await mailMarksForJobs(db)).get(jobA)).toEqual({ confirmed: false, badge: 'oferta' });
    await raiseAlert(db, { kind: 'interview', jobId: jobA, mailMessageId: offerA }, 1200);
    expect((await mailMarksForJobs(db)).get(jobA)).toEqual({ confirmed: false, badge: 'entrevista' });
  });

  it('hands out phone alerts up to three attempts', async () => {
    const jobId = await seedJob('a', 'Acme', 'Dev');
    const m1 = await seedMessage('<m1@acme.example>', jobId, 'entrevista');
    const m2 = await seedMessage('<m2@acme.example>', jobId, 'oferta');
    const draft = (await raiseAlert(db, { kind: 'draft', jobId, mailMessageId: m1 }, 500))!; // não vai ao celular
    const first = (await raiseAlert(db, { kind: 'interview', jobId, mailMessageId: m1 }, 1000))!;
    const second = (await raiseAlert(db, { kind: 'offer', jobId, mailMessageId: m2 }, 2000))!;

    expect((await nextPhoneAlert(db))!).toMatchObject({ id: first, kind: 'interview', company: 'Acme' });
    for (let i = 0; i < 3; i++) await markPhoneAttempt(db, first, false, 3000 + i);
    expect((await alertById(db, first))!).toMatchObject({ phoneAttempts: 3, phoneSentAt: null });
    expect((await nextPhoneAlert(db))!.id).toBe(second);
    await markPhoneAttempt(db, second, true, 4000);
    expect((await alertById(db, second))!).toMatchObject({ phoneAttempts: 1, phoneSentAt: 4000 });
    expect(await nextPhoneAlert(db)).toBeNull();
    // A falha no celular nunca apaga o alerta do app.
    expect((await openAlerts(db)).map((a) => a.id).sort()).toEqual([draft, first, second].sort());
  });

  it('skips a dismissed alert for the phone', async () => {
    const jobId = await seedJob('a', 'Acme', 'Dev');
    const m1 = await seedMessage('<m1@acme.example>', jobId, 'entrevista');
    const id = (await raiseAlert(db, { kind: 'interview', jobId, mailMessageId: m1 }, 1000))!;
    await dismissAlert(db, id, 1100);
    expect(await nextPhoneAlert(db)).toBeNull();
    expect(await db.select().from(alerts)).toHaveLength(1);
  });
});
