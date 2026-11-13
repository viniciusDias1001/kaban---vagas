import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiError, createFakeProvider, type AiConfig, type AiProvider } from '@kv/ai';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import {
  applyAnswers, createReply, deleteMailAccount, ensureSeedAnswers, getMailAccount, insertMailMessage, mailMessages, markReplySending,
  replyById, saveMailAccount, saveProfile, updateMailAccount, type Db,
} from '@kv/db';
import { resetTestDb } from '@kv/db/testing';
import { MailTransientError, createFakeMailbox, readFakeMailbox, writeFakeMailbox, type Mailbox } from '@kv/mail';
import { createSettingsService, type SettingsService } from '@kv/settings';
import { MAIL_LIMITS } from '@kv/shared';
import { eq } from 'drizzle-orm';
import { createMailAi, type MailAi } from './ai-calls';
import { createMailQueue, type MailQueue, type MailQueueDeps } from './queue';
import { CONNECTED_AT, DAY, HOUR, MAIL_NOW, OWNER_ADDRESS, mailTestBed } from './test-helpers';

type Bed = Awaited<ReturnType<typeof mailTestBed>>;
let bed: Bed;
let db: Db;
let dir: string;
let settings: SettingsService;
let clock: number;
let logs: string[];
let opens: number;
let closes: number;
let aiCalls: number;

const CONFIG: AiConfig = {
  provider: 'fake', apiKey: '', models: { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' }, dailyBudgetUsd: 1, budgetTimeZone: 'America/Sao_Paulo',
};
const POLL = MAIL_LIMITS.pollMs;

/** O falso com preço conhecido; conta as chamadas. */
function counting(): AiProvider {
  const fake = createFakeProvider();
  return {
    id: 'fake',
    async generate(req) {
      aiCalls += 1;
      const res = await fake.generate(req);
      return { ...res, model: CONFIG.models[req.tier], usage: { inputTokens: 1_000, outputTokens: 100 } };
    },
  };
}

function mailAi(provider: AiProvider = counting()): MailAi {
  return createMailAi({ db, ai: async () => ({ provider, config: CONFIG }), now: () => clock, log: (m) => logs.push(m) });
}

/** A caixa falsa da bancada; conta aberturas e fechamentos; `over` troca o que o teste precisa. */
function opening(over: (mailbox: Mailbox) => Partial<Mailbox> = () => ({})): () => Promise<Mailbox> {
  return async () => {
    opens += 1;
    const base = createFakeMailbox(dir, { address: OWNER_ADDRESS, password: 'senha-de-teste' });
    return { ...base, ...over(base), close: async () => { closes += 1; await base.close(); } };
  };
}

function makeQueue(over: Partial<MailQueueDeps> = {}): MailQueue {
  return createMailQueue({
    db, settings, ai: mailAi(), now: () => clock, log: (m) => logs.push(m), openMailbox: opening(),
    availability: () => ({ available: true, reason: null }), resume: async () => null, ...over,
  });
}

async function step(queue: MailQueue): Promise<{ read: boolean; worked: boolean }> {
  const result = await queue.tick();
  await queue.idle();
  return result;
}

/** O pedido de pretensão salarial da Acme, que o código responde sozinho com o valor salvo. */
function deliverSalaryRequest(): void {
  bed.deliver({
    messageId: 'pedido-1@acme.com', from: { address: 'joana@acme.com', name: 'Joana (Acme)' },
    subject: 'Sua candidatura na Acme', text: 'Olá! Qual a sua pretensão salarial?', date: MAIL_NOW - HOUR,
  });
}

/** Mensagens que não são de vaga (o filtro as descarta sem guardar nada). */
function deliverNoise(n: number): void {
  for (let i = 0; i < n; i++) {
    bed.deliver({ from: { address: `news${i}@loja.example`, name: 'Loja' }, subject: `Promoção ${i}`, text: 'Ofertas.', date: MAIL_NOW - HOUR });
  }
}

const sentFolder = () => readFakeMailbox(dir).messages.filter((m) => m.folder === 'sent');

beforeAll(async () => {
  bed = await mailTestBed();
  ({ db, dir } = bed);
});
afterAll(() => bed.close());
beforeEach(async () => {
  await resetTestDb(db);
  writeFakeMailbox(dir, { uidValidity: 1, messages: [] });
  await saveMailAccount(db, OWNER_ADDRESS, CONNECTED_AT);
  await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', MAIL_NOW - 30 * DAY);
  await ensureSeedAnswers(db, MAIL_NOW - 30 * DAY);
  await db.update(applyAnswers).set({ answer: '20000' }).where(eq(applyAnswers.key, 'salary_brl_month'));
  await bed.seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - 10 * DAY);
  settings = createSettingsService(db, { env: {} });
  clock = MAIL_NOW;
  logs = [];
  opens = 0;
  closes = 0;
  aiCalls = 0;
});

describe('createMailQueue', () => {
  it('reads, classifies, acts and sends across ticks', async () => {
    deliverSalaryRequest();
    const queue = makeQueue();
    for (let i = 0; i < 6; i++) await step(queue);
    expect(sentFolder()).toHaveLength(1);
    expect(sentFolder()[0]).toMatchObject({ to: ['joana@acme.com'], inReplyTo: 'pedido-1@acme.com' });
    expect(opens).toBe(closes);
  });

  describe('does nothing', () => {
    const cases: [string, () => Promise<Partial<MailQueueDeps>>][] = [
      ['off a local host', async () => ({ availability: () => ({ available: false, reason: 'HOST não local' }) })],
      ['without a mailbox', async () => { await deleteMailAccount(db); return {}; }],
      ['when turned off', async () => { await settings.update({ emailEnabled: false }); return {}; }],
      ['when paused', async () => { await updateMailAccount(db, { paused: true }); return {}; }],
    ];
    for (const [name, setup] of cases) {
      it(name, async () => {
        deliverSalaryRequest();
        await insertMailMessage(db, {
          messageId: 'velha@acme.com', threadKey: 'velha', direction: 'in', uid: null, fromAddress: 'joana@acme.com', fromName: 'Joana',
          toAddress: OWNER_ADDRESS, replyTo: null, subject: 'Acme', sentAt: MAIL_NOW - HOUR, body: 'Qual a sua pretensão salarial?',
          inReplyTo: null, refs: [], autoSubmitted: false, listId: false, backfill: false,
        }, MAIL_NOW);
        const queue = makeQueue(await setup());
        for (let i = 0; i < 3; i++) expect(await step(queue)).toEqual({ read: false, worked: false });
        expect(opens).toBe(0);
        expect(aiCalls).toBe(0);
        expect((await db.select().from(mailMessages)).map((m) => m.kind)).toEqual([null]);
      });
    }
  });

  it('reads again only after the poll interval', async () => {
    const queue = makeQueue();
    expect(await step(queue)).toEqual({ read: true, worked: false });
    expect(await step(queue)).toEqual({ read: false, worked: true });
    clock += POLL - 1;
    expect(await step(queue)).toEqual({ read: false, worked: true });
    clock += 1;
    expect(await step(queue)).toEqual({ read: true, worked: false });
  });

  it('keeps reading on the next tick while there is more', async () => {
    deliverNoise(MAIL_LIMITS.fetchBatch + 10);
    const queue = makeQueue();
    expect((await step(queue)).read).toBe(true);
    expect((await getMailAccount(db))!.lastUid).toBe(MAIL_LIMITS.fetchBatch);
    expect((await step(queue)).read).toBe(true);
    expect((await getMailAccount(db))!.lastUid).toBe(MAIL_LIMITS.fetchBatch + 10);
    expect((await step(queue)).read).toBe(false);
  });

  it('closes the mailbox after every unit, also on error', async () => {
    deliverSalaryRequest();
    const queue = makeQueue();
    for (let i = 0; i < 6; i++) await step(queue);
    expect(opens).toBeGreaterThanOrEqual(2); // a leitura e o envio
    expect(closes).toBe(opens);

    clock += POLL;
    const failing = makeQueue({ openMailbox: opening(() => ({ fetchInbox: async () => { throw new MailTransientError('a rede caiu'); } })) });
    opens = 0;
    closes = 0;
    await expect(step(failing)).resolves.toEqual({ read: true, worked: false });
    expect(opens).toBe(1);
    expect(closes).toBe(1);
    expect(logs.some((l) => l.includes('a rede caiu'))).toBe(true);
    expect((await getMailAccount(db))!.error).toBe('a rede caiu');
  });

  it('waits the poll interval after a transient error before reading again', async () => {
    const queue = makeQueue({ openMailbox: opening(() => ({ fetchInbox: async () => { throw new MailTransientError('tempo esgotado'); } })) });
    expect((await step(queue)).read).toBe(true);
    expect((await step(queue)).read).toBe(false);
    clock += POLL;
    expect((await step(queue)).read).toBe(true);
  });

  it('survives a failing unit', async () => {
    deliverSalaryRequest();
    const ai = mailAi();
    let broken = true;
    const flaky: MailAi = {
      ...ai,
      configured: async () => {
        if (broken) { broken = false; throw new Error('falha inesperada'); }
        return ai.configured();
      },
    };
    const queue = makeQueue({ ai: flaky });
    await step(queue); // leitura
    await expect(queue.tick()).resolves.toEqual({ read: false, worked: true });
    await queue.idle();
    expect(logs.some((l) => l.includes('falha inesperada'))).toBe(true);
    const [row] = await db.select().from(mailMessages);
    expect(row!.kind).toBeNull();
    await step(queue);
    expect((await db.select().from(mailMessages))[0]!.kind).toBe('pedido');
  });

  it('classifies no more in the round after the provider is off, and again after the next read', async () => {
    deliverSalaryRequest();
    const down: AiProvider = { id: 'fake', generate: async () => { aiCalls += 1; throw new AiError('transient', 'o provedor caiu'); } };
    const queue = makeQueue({ ai: mailAi(down) });
    await step(queue); // leitura
    await step(queue);
    expect(aiCalls).toBe(1);
    await step(queue);
    await step(queue);
    expect(aiCalls).toBe(1);
    clock += POLL;
    await step(queue); // nova leitura
    await step(queue);
    expect(aiCalls).toBe(2);
  });

  it('closes the first read only after a read that found nothing more', async () => {
    deliverNoise(MAIL_LIMITS.fetchBatch + 10);
    let reads = 0;
    const queue = makeQueue({
      openMailbox: opening((base) => ({
        fetchInbox: async (opts) => {
          reads += 1;
          if (reads === 2) throw new MailTransientError('a rede caiu');
          return base.fetchInbox(opts);
        },
      })),
    });
    expect((await step(queue)).read).toBe(true); // um lote cheio: há mais
    expect((await step(queue)).read).toBe(true); // falha
    for (let i = 0; i < 3; i++) expect((await step(queue)).worked).toBe(true);
    expect((await getMailAccount(db))!.backfillDone).toBe(false);
    clock += POLL;
    expect((await step(queue)).read).toBe(true); // o resto
    await step(queue);
    expect((await getMailAccount(db))!.backfillDone).toBe(true);
  });

  describe('interrupted sends', () => {
    let replyId: number;
    beforeEach(async () => {
      const id = await insertMailMessage(db, {
        messageId: 'pedido-9@acme.com', threadKey: 'pedido-9@acme.com', direction: 'in', uid: null, fromAddress: 'joana@acme.com',
        fromName: 'Joana', toAddress: OWNER_ADDRESS, replyTo: null, subject: 'Acme', sentAt: MAIL_NOW - HOUR, body: 'Pretensão?',
        inReplyTo: null, refs: [], autoSubmitted: false, listId: false, backfill: false,
      }, MAIL_NOW);
      replyId = (await createReply(db, {
        messageId: id!, origin: 'facts', items: ['salary'], toAddress: 'joana@acme.com', subject: 'Re: Acme', body: 'R$ 20.000.',
        attachResume: false, state: 'aprovada', approvedBy: 'auto',
      }, MAIL_NOW))!;
      expect(await markReplySending(db, replyId, 'out-1@kanban-vagas.local')).toBe(true);
    });

    it('recovers an interrupted send at start', async () => {
      const queue = makeQueue();
      await queue.recoverInterrupted();
      expect(await replyById(db, replyId)).toMatchObject({ state: 'rascunho' });
      expect(sentFolder()).toHaveLength(0);
      expect(closes).toBe(opens);
    });

    it('leaves it alone while paused, and recovers it once the mailbox is usable again', async () => {
      await updateMailAccount(db, { paused: true });
      const queue = makeQueue();
      await queue.recoverInterrupted();
      for (let i = 0; i < 3; i++) await step(queue);
      expect(opens).toBe(0);
      expect(await replyById(db, replyId)).toMatchObject({ state: 'enviando' });
      await updateMailAccount(db, { paused: false });
      for (let i = 0; i < 8; i++) await step(queue);
      expect(await replyById(db, replyId)).toMatchObject({ state: 'rascunho' });
      expect(sentFolder()).toHaveLength(0);
    });
  });
});
