import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createFakeProvider, type AiConfig, type AiProvider } from '@kv/ai';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import {
  applyAnswers, ensureSeedAnswers, getMailAccount, insertMailMessage, jobEvents, jobs, mailMessageById, mailMessages, mailReplies, openAlerts,
  recordUsage, replyForMessage, saveClassification, saveMailAccount, saveProfile, updateMailAccount, alerts as alertsTable,
  type Db, type NewMailMessage,
} from '@kv/db';
import { resetTestDb } from '@kv/db/testing';
import { createSettingsService } from '@kv/settings';
import type { EmailKind, EmailLang, EmailRequest } from '@kv/shared';
import { createMailAi, type MailAi } from './ai-calls';
import { actOnNext, finishBackfill } from './act';
import type { MailWorkDeps } from './classify';
import { CONNECTED_AT, DAY, HOUR, MAIL_NOW, OWNER_ADDRESS, mailTestBed } from './test-helpers';

type Bed = Awaited<ReturnType<typeof mailTestBed>>;
let bed: Bed;
let db: Db;
let deps: MailWorkDeps;
let acme: number;
let calls: string[];

const CONFIG: AiConfig = {
  provider: 'fake', apiKey: '', models: { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' }, dailyBudgetUsd: 1, budgetTimeZone: 'America/Sao_Paulo',
};

/** O falso com o modelo de preço conhecido; registra as tarefas chamadas. */
function recording(): AiProvider {
  const fake = createFakeProvider();
  return {
    id: 'fake',
    async generate(req) {
      calls.push(req.tier);
      const res = await fake.generate(req);
      return { ...res, model: CONFIG.models[req.tier], usage: { inputTokens: 1_000, outputTokens: 100 } };
    },
  };
}

function mailAi(provider: AiProvider = recording()): MailAi {
  return createMailAi({ db, ai: async () => ({ provider, config: CONFIG }), now: () => MAIL_NOW, log: () => {} });
}

let seq = 0;
/** Uma mensagem recebida, já classificada como `kind`. A vaga padrão é a Acme. */
async function classified(
  kind: EmailKind,
  over: Partial<NewMailMessage> = {},
  c: { requests?: EmailRequest[]; lang?: EmailLang; jobId?: number | null } = {},
): Promise<number> {
  seq += 1;
  const id = (await insertMailMessage(db, {
    messageId: `in-${seq}@acme.com`, threadKey: `t-${seq}`, direction: 'in', uid: seq, fromAddress: 'joana@acme.com',
    fromName: 'Joana (Acme)', toAddress: OWNER_ADDRESS, replyTo: null, subject: 'Sua candidatura na Acme', sentAt: MAIL_NOW - HOUR,
    body: 'Texto do e-mail.', inReplyTo: null, refs: [], autoSubmitted: false, listId: false, backfill: false, ...over,
  }, MAIL_NOW))!;
  await saveClassification(db, id, {
    kind, summary: `Resumo: ${kind}.`, lang: c.lang ?? 'pt-BR', requests: c.requests ?? [], jobId: c.jobId === undefined ? acme : c.jobId,
  }, MAIL_NOW);
  return id;
}

const req = (fact: EmailRequest['fact'], note: string = fact): EmailRequest => ({ fact, note });
const column = async (jobId: number) => (await db.select({ c: jobs.column }).from(jobs).where(eq(jobs.id, jobId)))[0]!.c;
const lastEvent = async (jobId: number) =>
  (await db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(desc(jobEvents.id)).limit(1))[0];
const eventCount = async () => (await db.select().from(jobEvents)).length;
async function setAnswer(key: string, answer: string): Promise<void> {
  await db.update(applyAnswers).set({ answer }).where(and(eq(applyAnswers.key, key)));
}
/** O dono moveu o card para `to` em `at`. */
async function ownerMoves(jobId: number, to: typeof jobs.$inferSelect.column, at: number): Promise<void> {
  const from = await column(jobId);
  await db.update(jobs).set({ column: to }).where(eq(jobs.id, jobId));
  await db.insert(jobEvents).values({ jobId, fromColumn: from, toColumn: to, actor: 'humano', createdAt: at });
}

beforeAll(async () => {
  bed = await mailTestBed();
  db = bed.db;
});
afterAll(() => bed.close());
beforeEach(async () => {
  await resetTestDb(db);
  await saveMailAccount(db, OWNER_ADDRESS, CONNECTED_AT);
  await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', MAIL_NOW - 30 * DAY);
  await ensureSeedAnswers(db, MAIL_NOW - 30 * DAY);
  await setAnswer('salary_brl_month', '20000');
  acme = await bed.seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - 10 * DAY);
  calls = [];
  deps = { db, settings: createSettingsService(db, { env: {} }), ai: mailAi(), now: () => MAIL_NOW, log: () => {} };
});

describe('actOnNext: moves and alerts', () => {
  it('moves a rejected card to Perdida with the mail on the event and no alert', async () => {
    const messageId = await classified('reprovacao');
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('perdida');
    expect(await lastEvent(acme)).toMatchObject({ actor: 'email', mailMessageId: messageId, fromColumn: 'aplicada', toColumn: 'perdida' });
    expect(await openAlerts(db)).toEqual([]);
    expect((await mailMessageById(db, messageId))!.processedAt).toBe(MAIL_NOW);
    expect(calls).toEqual([]); // nenhuma chamada ao modelo
  });

  it('moves an invited card to Entrevista, alerts and leaves a draft waiting', async () => {
    const messageId = await classified('entrevista');
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('entrevista');
    const [alert] = await openAlerts(db);
    expect(alert).toMatchObject({ kind: 'interview', jobId: acme, messageId, replyId: expect.any(Number) });
    const reply = await replyForMessage(db, messageId);
    expect(reply).toMatchObject({
      id: alert!.replyId, origin: 'ai', state: 'rascunho', toAddress: 'joana@acme.com', subject: 'Re: Sua candidatura na Acme',
      items: [], attachResume: false, approvedBy: null,
    });
    expect(reply!.body).toContain('Maria Exemplo da Silva');
    expect(calls).toEqual(['strong']);
  });

  it('alerts on an offer and writes no reply', async () => {
    const messageId = await classified('oferta');
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('oferta');
    expect((await openAlerts(db)).map((a) => a.kind)).toEqual(['offer']);
    expect(await replyForMessage(db, messageId)).toBeNull();
  });

  it('alerts on an invite even when the card does not move', async () => {
    await ownerMoves(acme, 'arquivada', MAIL_NOW - 2 * DAY);
    await classified('entrevista');
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('arquivada');
    expect((await openAlerts(db))[0]).toMatchObject({ kind: 'interview', jobId: acme });
  });

  it('alerts on an offer even when the card does not move', async () => {
    await ownerMoves(acme, 'perdida', MAIL_NOW - 2 * DAY);
    await classified('oferta');
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('perdida');
    expect((await openAlerts(db)).map((a) => a.kind)).toEqual(['offer']);
  });

  it('only asks in confirm mode', async () => {
    await deps.settings.update({ emailMoveMode: 'confirm' });
    const messageId = await classified('reprovacao');
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('aplicada');
    expect(await openAlerts(db)).toEqual([
      expect.objectContaining({ kind: 'move_confirm', jobId: acme, messageId, payload: { moveTo: 'perdida' } }),
    ]);
  });

  it('asks nothing in confirm mode when the mail would not move the card', async () => {
    await deps.settings.update({ emailMoveMode: 'confirm' });
    await ownerMoves(acme, 'perdida', MAIL_NOW - 2 * DAY);
    await classified('reprovacao');
    expect(await actOnNext(deps)).toBe(true);
    expect(await openAlerts(db)).toEqual([]);
  });

  it('an older rejection processed after a newer invite leaves the card in Entrevista', async () => {
    const invite = await classified('entrevista', { sentAt: MAIL_NOW - HOUR });
    const rejection = await classified('reprovacao', { sentAt: MAIL_NOW - 2 * HOUR });
    // O convite é tratado primeiro (a reprovação chegou à classificação depois).
    await db.update(mailMessages).set({ kind: null }).where(eq(mailMessages.id, rejection));
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('entrevista');
    await db.update(mailMessages).set({ kind: 'reprovacao' }).where(eq(mailMessages.id, rejection));
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('entrevista');
    expect(await lastEvent(acme)).toMatchObject({ mailMessageId: invite });
    expect((await mailMessageById(db, rejection))!.processedAt).toBe(MAIL_NOW);
  });

  it('opens an unmatched alert for decisive mail without a card', async () => {
    const invite = await classified('entrevista', {}, { jobId: null });
    await classified('outro', { sentAt: MAIL_NOW - 30 * 60_000 }, { jobId: null });
    expect(await actOnNext(deps)).toBe(true);
    expect(await actOnNext(deps)).toBe(true);
    expect(await openAlerts(db)).toEqual([expect.objectContaining({ kind: 'unmatched', messageId: invite, jobId: null })]);
    expect(await replyForMessage(db, invite)).toBeNull();
    expect(await column(acme)).toBe('aplicada');
    expect(calls).toEqual([]);
  });

  it('does nothing for an acknowledgement or other mail', async () => {
    await classified('recebimento');
    await classified('outro');
    await classified('pedido', {}, { requests: [] }); // pedido sem itens: como `outro`
    expect(await actOnNext(deps)).toBe(true);
    expect(await actOnNext(deps)).toBe(true);
    expect(await actOnNext(deps)).toBe(true);
    expect(await actOnNext(deps)).toBe(false);
    expect(await openAlerts(db)).toEqual([]);
    expect(await db.select().from(mailReplies)).toEqual([]);
    expect(await eventCount()).toBe(1);
  });

  it('acting twice changes nothing', async () => {
    const messageId = await classified('entrevista');
    expect(await actOnNext(deps)).toBe(true);
    expect(await actOnNext(deps)).toBe(false);
    expect(await eventCount()).toBe(2); // o da bancada e o do e-mail
    expect(await openAlerts(db)).toHaveLength(1);
    expect(await db.select().from(mailReplies).where(eq(mailReplies.messageId, messageId))).toHaveLength(1);
  });

  it('leaves no half-done action when the transaction fails', async () => {
    const messageId = await classified('entrevista');
    await db.execute(sql.raw(`create or replace function kv_test_fail() returns trigger language plpgsql as $$
      begin raise exception 'falha simulada ao gravar a resposta'; end $$`));
    await db.execute(sql.raw('create trigger kv_test_fail before insert on mail_replies for each row execute function kv_test_fail()'));
    try {
      await expect(actOnNext(deps)).rejects.toThrow();
    } finally {
      await db.execute(sql.raw('drop trigger kv_test_fail on mail_replies'));
    }
    expect(await column(acme)).toBe('aplicada');
    expect(await eventCount()).toBe(1);
    expect(await db.select().from(alertsTable)).toEqual([]);
    expect((await mailMessageById(db, messageId))!.processedAt).toBeNull();
    // Refeito sem a falha, tudo acontece uma vez.
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('entrevista');
  });
});

describe('actOnNext: replies', () => {
  it('answers a request made only of saved facts without asking', async () => {
    const messageId = await classified('pedido', {}, { requests: [req('salary', 'Pretensão salarial')] });
    expect(await actOnNext(deps)).toBe(true);
    const reply = await replyForMessage(db, messageId);
    expect(reply).toMatchObject({
      origin: 'facts', state: 'aprovada', approvedBy: 'auto', toAddress: 'joana@acme.com', items: ['salary'],
      subject: 'Re: Sua candidatura na Acme', attachResume: false, body: expect.stringContaining('R$ 20.000 por mês'),
    });
    expect(reply!.body.trim().endsWith('Maria Exemplo da Silva')).toBe(true);
    expect(await openAlerts(db)).toEqual([]);
    expect(await column(acme)).toBe('aplicada');
    expect(calls).toEqual([]); // nenhuma palavra vem do modelo
  });

  it('writes the reply in the language of the mail and attaches the résumé when asked', async () => {
    const messageId = await classified('pedido', { subject: 'Your application at Acme' }, {
      lang: 'en', requests: [req('salary'), req('resume')],
    });
    expect(await actOnNext(deps)).toBe(true);
    const reply = await replyForMessage(db, messageId);
    expect(reply).toMatchObject({ state: 'aprovada', items: ['salary', 'resume'], attachResume: true, subject: 'Re: Your application at Acme' });
    expect(reply!.body).toContain('Salary expectation: BRL 20,000 per month');
    expect(reply!.body).toContain('My résumé is attached.');
  });

  it('waits for approval in approve mode', async () => {
    await deps.settings.update({ emailFactsMode: 'approve' });
    const messageId = await classified('pedido', {}, { requests: [req('salary')] });
    expect(await actOnNext(deps)).toBe(true);
    const reply = await replyForMessage(db, messageId);
    expect(reply).toMatchObject({ origin: 'facts', state: 'rascunho', approvedBy: null });
    expect(await openAlerts(db)).toEqual([
      expect.objectContaining({ kind: 'draft', jobId: acme, replyId: reply!.id, payload: {} }),
    ]);
  });

  it('names the recipient on the draft alert only when it is not the sender', async () => {
    await deps.settings.update({ emailFactsMode: 'approve' });
    const toSender = await classified('pedido', { replyTo: ' JOANA@acme.com ' }, { requests: [req('salary')] });
    expect(await actOnNext(deps)).toBe(true);
    const own = (await openAlerts(db)).find((a) => a.messageId === toSender);
    expect(own).toMatchObject({ kind: 'draft' });
    expect(own!.payload.recipient).toBeUndefined();
    const toOther = await classified('pedido', { replyTo: 'dados@fora.example' }, { requests: [req('salary')] });
    expect(await actOnNext(deps)).toBe(true);
    expect((await openAlerts(db)).find((a) => a.messageId === toOther)).toMatchObject({
      kind: 'draft', payload: { recipient: 'dados@fora.example' },
    });
  });

  it('writes nothing in off mode', async () => {
    await deps.settings.update({ emailFactsMode: 'off' });
    const messageId = await classified('pedido', {}, { requests: [req('salary')] });
    expect(await actOnNext(deps)).toBe(true);
    expect(await replyForMessage(db, messageId)).toBeNull();
    expect(await openAlerts(db)).toEqual([]);
    expect((await mailMessageById(db, messageId))!.processedAt).toBe(MAIL_NOW);
  });

  it('never sends on its own to a Reply-To outside the trusted addresses', async () => {
    const messageId = await classified('pedido', { replyTo: 'dados@fora.example' }, { requests: [req('salary')] });
    expect(await actOnNext(deps)).toBe(true);
    expect(await replyForMessage(db, messageId)).toMatchObject({ state: 'rascunho', toAddress: 'dados@fora.example', approvedBy: null });
    expect((await openAlerts(db))[0]).toMatchObject({ kind: 'draft', payload: { recipient: 'dados@fora.example' } });
  });

  it('sends on its own to an address the owner already wrote to in the thread', async () => {
    await insertMailMessage(db, {
      messageId: 'antes@ats.example', threadKey: 'fio', direction: 'out', uid: null, fromAddress: OWNER_ADDRESS, fromName: 'Maria',
      toAddress: 'recrutamento@ats.example', replyTo: null, subject: 'Re: vaga', sentAt: MAIL_NOW - 2 * HOUR, body: 'Oi',
      inReplyTo: null, refs: [], autoSubmitted: false, listId: false, backfill: false, settled: true,
    }, MAIL_NOW);
    const messageId = await classified('pedido', { threadKey: 'fio', replyTo: 'recrutamento@ats.example' }, { requests: [req('salary')] });
    expect(await actOnNext(deps)).toBe(true);
    expect(await replyForMessage(db, messageId)).toMatchObject({ state: 'aprovada', toAddress: 'recrutamento@ats.example' });
  });

  it('asks the owner when a requested fact has no saved value', async () => {
    const messageId = await classified('pedido', {}, { requests: [req('salary'), req('start_availability')] });
    expect(await actOnNext(deps)).toBe(true);
    expect(await replyForMessage(db, messageId)).toBeNull();
    expect(await openAlerts(db)).toEqual([
      expect.objectContaining({ kind: 'missing_fact', jobId: acme, messageId, payload: { missing: ['start_availability'] } }),
    ]);
  });

  it('treats every fact as missing when there is no profile', async () => {
    await db.execute(sql`truncate table profiles`);
    const messageId = await classified('pedido', {}, { requests: [req('salary'), req('resume')] });
    expect(await actOnNext(deps)).toBe(true);
    expect(await replyForMessage(db, messageId)).toBeNull();
    expect((await openAlerts(db))[0]).toMatchObject({ kind: 'missing_fact', payload: { missing: ['salary', 'resume'] } });
  });

  it('drafts with the model when something is outside the saved facts', async () => {
    const messageId = await classified('pedido', {}, { requests: [req('salary'), req('outro', 'Carta de recomendação')] });
    expect(await actOnNext(deps)).toBe(true);
    const reply = await replyForMessage(db, messageId);
    expect(reply).toMatchObject({ origin: 'ai', state: 'rascunho', items: ['salary'], toAddress: 'joana@acme.com', approvedBy: null });
    expect(await openAlerts(db)).toEqual([
      expect.objectContaining({ kind: 'draft', jobId: acme, replyId: reply!.id, payload: {} }),
    ]);
    expect(calls).toEqual(['strong']);
  });

  it('alerts without a draft when AI drafts are off', async () => {
    await deps.settings.update({ emailAiDrafts: false });
    const invite = await classified('entrevista');
    const request = await classified('pedido', { sentAt: MAIL_NOW - 30 * 60_000 }, { requests: [req('outro', 'Carta de recomendação')] });
    expect(await actOnNext(deps)).toBe(true);
    expect(await actOnNext(deps)).toBe(true);
    expect(await replyForMessage(db, invite)).toBeNull();
    expect(await replyForMessage(db, request)).toBeNull();
    const alerts = await openAlerts(db);
    expect(alerts.map((a) => [a.kind, a.replyId])).toEqual([['draft', null], ['interview', null]]);
    expect(calls).toEqual([]);
  });

  it('alerts without a draft when the budget is spent or the draft fails the check', async () => {
    await recordUsage(db, { provider: 'fake', model: 'x', layer: 'tier1', inputTokens: 0, outputTokens: 0, costUsd: 5, createdAt: MAIL_NOW });
    const invite = await classified('entrevista');
    expect(await actOnNext(deps)).toBe(true);
    expect(await replyForMessage(db, invite)).toBeNull();
    expect((await openAlerts(db))[0]).toMatchObject({ kind: 'interview', replyId: null });
    expect(calls).toEqual([]);

    await db.execute(sql`truncate table ai_usage`);
    const forged = await classified('entrevista', { sentAt: MAIL_NOW - 30 * 60_000, body: 'FAKE_AI_COMPROMISED' });
    expect(await actOnNext(deps)).toBe(true);
    expect(calls).toEqual(['strong', 'strong']); // uma segunda tentativa levando as violações
    expect(await replyForMessage(db, forged)).toBeNull();
  });

  it('writes no reply for mail that takes none', async () => {
    const noReply = await classified('pedido', { fromAddress: 'no-reply@acme.com' }, { requests: [req('salary')] });
    const auto = await classified('entrevista', { sentAt: MAIL_NOW - 50 * 60_000, autoSubmitted: true });
    const twoAddresses = await classified('entrevista', { sentAt: MAIL_NOW - 40 * 60_000, replyTo: 'a@acme.com, b@acme.com' });
    for (let i = 0; i < 3; i++) expect(await actOnNext(deps)).toBe(true);
    for (const id of [noReply, auto, twoAddresses]) expect(await replyForMessage(db, id)).toBeNull();
    const byMessage = new Map((await openAlerts(db)).map((a) => [a.messageId, a]));
    const cannot = 'Este e-mail não aceita resposta.';
    expect(byMessage.get(noReply)).toMatchObject({ kind: 'draft', replyId: null, payload: { reason: cannot } });
    expect(byMessage.get(auto)).toMatchObject({ kind: 'interview', payload: { reason: cannot } });
    expect(byMessage.get(twoAddresses)).toMatchObject({
      kind: 'interview', payload: { reason: 'Este e-mail pede resposta para mais de um endereço. Responda você mesmo.' },
    });
    expect(calls).toEqual([]);
  });
});

describe('first read', () => {
  it('backfill mail moves the card and stays silent', async () => {
    const globex = await bed.seedAppliedJob('Globex', 'Engenheira de Dados', MAIL_NOW - 10 * DAY);
    await classified('reprovacao', { backfill: true, sentAt: CONNECTED_AT - 3 * DAY });
    await classified('entrevista', { backfill: true, sentAt: CONNECTED_AT - 2 * DAY, fromAddress: 'rh@globex.com' }, { jobId: globex });
    await updateMailAccount(db, { lastReadAt: MAIL_NOW });
    expect(await finishBackfill(deps)).toBe(false); // ainda há o que tratar
    expect(await actOnNext(deps)).toBe(true);
    expect(await actOnNext(deps)).toBe(true);
    expect(await column(acme)).toBe('perdida');
    expect(await column(globex)).toBe('entrevista');
    expect(await openAlerts(db)).toEqual([]);
    expect(await db.select().from(mailReplies)).toEqual([]);
    expect(calls).toEqual([]);

    expect(await finishBackfill(deps)).toBe(true);
    expect(await openAlerts(db)).toEqual([
      expect.objectContaining({ kind: 'backfill_summary', payload: { total: 2, counts: { reprovacao: 1, entrevista: 1 } } }),
    ]);
    expect((await getMailAccount(db))!.backfillDone).toBe(true);
    expect(await finishBackfill(deps)).toBe(false);
  });

  it('finishes silently when the first read found nothing, and waits for the first read', async () => {
    expect(await finishBackfill(deps)).toBe(false); // a primeira leitura ainda não aconteceu
    await updateMailAccount(db, { lastReadAt: MAIL_NOW });
    expect(await finishBackfill(deps)).toBe(true);
    expect(await openAlerts(db)).toEqual([]);
    expect((await getMailAccount(db))!.backfillDone).toBe(true);
  });

  it('waits for backfill mail that is not classified yet', async () => {
    await insertMailMessage(db, {
      messageId: 'velho@acme.com', threadKey: 'v', direction: 'in', uid: 1, fromAddress: 'joana@acme.com', fromName: 'Joana',
      toAddress: OWNER_ADDRESS, replyTo: null, subject: 'Sua candidatura na Acme', sentAt: CONNECTED_AT - DAY, body: 'x',
      inReplyTo: null, refs: [], autoSubmitted: false, listId: false, backfill: true,
    }, MAIL_NOW);
    await updateMailAccount(db, { lastReadAt: MAIL_NOW });
    expect(await finishBackfill(deps)).toBe(false);
  });
});

