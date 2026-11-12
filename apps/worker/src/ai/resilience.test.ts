import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { AiError, createFakeProvider, estimateInterruptedUsage, type AiConfig, type AiProvider, type AiRequest } from '@kv/ai';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import {
  ESTIMATED_MODEL_SUFFIX, aiTasks, aiUsage, closeDb, enqueueAiTask, jobAi, jobs, profileFor, providerWait, pruneAiTasks, recordUsage,
  resumeProviderWaits, saveProfile, type Db,
} from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { createExecutor, createFailureRecorder, createInterruptionRecorder } from './executors';
import { createAiQueue, type AiQueueOptions } from './queue';
import { TIER1_MAX_FAILURES, TIER1_RETRY_AFTER_MS, enqueueTier1ForNewJobs } from './sweep';
import { PROFILE_CHANGED_ERROR } from './task-errors';

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);
const HOUR = 3_600_000;
const config: AiConfig = {
  provider: 'fake', apiKey: 'fake', models: { fast: 'fake-fast', strong: 'fake-strong' }, dailyBudgetUsd: 1,
  budgetTimeZone: 'America/Sao_Paulo',
};

let db: Db;
let clock: number;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  clock = NOW;
});
afterAll(() => closeDb(db));

async function seedJobs(n: number, over: (i: number) => Partial<typeof jobs.$inferInsert> = () => ({})) {
  return db
    .insert(jobs)
    .values(
      Array.from({ length: n }, (_, i) => ({
        source: 'gupy', externalId: `${Math.random()}`, url: `https://example.com/${Math.random()}`, title: `Dev ${i}`,
        company: 'Acme Fictícia', location: '', country: 'BR' as const, remote: true, stacks: [], description: 'Vaga com React e Node.',
        postedAt: null, discoveredAt: 1, dedupHash: `${Math.random()}`, profileId: null, position: i, ...over(i),
      })),
    )
    .returning({ id: jobs.id });
}

/** Provedor que conta as chamadas e deixa o teste decidir a resposta; sem gancho, é o provedor falso. */
function counting(hook: (req: AiRequest<unknown>, call: number) => void | Promise<void> = () => {}) {
  const fake = createFakeProvider();
  const state = { calls: 0 };
  const provider: AiProvider = {
    id: 'fake',
    async generate(req) {
      state.calls++;
      await hook(req as AiRequest<unknown>, state.calls);
      return fake.generate(req);
    },
  };
  return { provider, state };
}

/** A fila de verdade com o executor de verdade, como o worker monta (`createAiRuntime`). */
function queueWith(provider: AiProvider, over: Partial<AiQueueOptions> = {}, cfg: AiConfig = config) {
  const ai = async () => ({ provider, config: cfg });
  return createAiQueue(db, createExecutor({ db, ai, fetchDescription: async () => null, now: () => clock }), {
    settings: async () => ({ enabled: true, dailyBudgetUsd: cfg.dailyBudgetUsd, budgetTimeZone: cfg.budgetTimeZone, sweepEnabled: true }),
    now: () => clock, onFailed: createFailureRecorder(db), backoffMs: [0, 0], sweep: () => enqueueTier1ForNewJobs(db, 50, clock),
    onInterrupted: createInterruptionRecorder({ db, ai, now: () => clock }),
    ...over,
  });
}
const states = async () => (await db.select().from(jobAi)).map((r) => r.tier1State);
const tasks = () => db.select().from(aiTasks).orderBy(asc(aiTasks.id));

describe('the provider is unavailable while tier 1 runs (revoked key, no credit, persistent 429)', () => {
  it('a refused key marks no job: the tasks wait, nothing else is called, and AI status can say why', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    await seedJobs(120);
    const bad = counting(() => {
      throw new AiError('config', 'a chave de API é inválida ou não tem permissão', 'auth');
    });
    const q1 = queueWith(bad.provider);
    for (let i = 0; i < 10; i++) await q1.drain();
    // No máximo as duas unidades que rodam ao mesmo tempo chegaram ao provedor.
    expect(bad.state.calls).toBeLessThanOrEqual(2);
    expect(await states()).toEqual([]);
    const waiting = await tasks();
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((t) => t.status === 'queued' && t.runAfter !== null && t.runAfter > clock)).toBe(true);
    const wait = await providerWait(db, clock);
    expect(wait).toMatchObject({ message: expect.stringContaining('chave de API'), tasks: waiting.length });
    expect(wait!.retryAt).toBeGreaterThan(clock);

    // O usuário corrige a chave na aba Configurações: a API libera as tarefas e a triagem retoma sozinha.
    expect(await resumeProviderWaits(db)).toBe(waiting.length);
    expect(await providerWait(db, clock)).toBeNull();
    const good = counting();
    const q2 = queueWith(good.provider);
    for (let i = 0; i < 10; i++) await q2.drain();
    const after = await states();
    expect(after.filter((s) => s === 'ok')).toHaveLength(120);
    expect(after.filter((s) => s === 'error')).toHaveLength(0);
  });

  it('without anyone fixing anything, the paused tasks are tried again after the long wait', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    await seedJobs(3);
    let broken = true;
    const p = counting(() => {
      if (broken) throw new AiError('config', 'a conta está sem crédito', 'billing');
    });
    const queue = queueWith(p.provider, { providerPauseMs: { config: 30 * 60_000, rate_limited: 15 * 60_000 } });
    await queue.drain();
    expect(p.state.calls).toBe(1);
    await queue.drain();
    expect(p.state.calls).toBe(1);
    broken = false;
    clock += 31 * 60_000;
    await queue.drain();
    expect(await states()).toEqual(['ok', 'ok', 'ok']);
  });

  it('a persistent rate limit is retried with the usual waits and then pauses, without marking the jobs', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    await seedJobs(2);
    const p = counting(() => {
      throw new AiError('rate_limited', 'limite de taxa do provedor');
    });
    const queue = queueWith(p.provider);
    await queue.drain();
    expect(p.state.calls).toBe(3);
    expect(await states()).toEqual([]);
    expect(await providerWait(db, clock)).toMatchObject({ message: 'limite de taxa do provedor', tasks: 2 });
    expect((await tasks()).every((t) => t.status === 'queued' && t.attempts === 0)).toBe(true);
  });

  it('a requested tier 2 that hits the same problem fails with the message, as before (the user asked and is looking)', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job.id }, NOW);
    const p = counting(() => {
      throw new AiError('config', 'a chave de API é inválida ou não tem permissão', 'auth');
    });
    await queueWith(p.provider, { sweep: undefined }).drain();
    expect((await tasks())[0]).toMatchObject({ type: 'tier2', status: 'error' });
    expect(await providerWait(db, clock)).toBeNull();
  });
});

describe('one job of a tier-1 batch makes the provider refuse', () => {
  const poison = (i: number) => (i === 3 ? { description: 'POISON-MARKER text that trips the provider safety filter' } : {});
  const refusing = () =>
    counting((req) => {
      if (req.prompt.includes('POISON-MARKER')) throw new AiError('refused', 'o modelo recusou o pedido');
    });

  it('re-runs the jobs one by one, so only the offending job is marked', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    await seedJobs(10, poison);
    const p = refusing();
    const queue = queueWith(p.provider);
    for (let i = 0; i < 5; i++) await queue.drain();
    const result = await states();
    expect(result.filter((s) => s === 'ok')).toHaveLength(9);
    expect(result.filter((s) => s === 'error')).toHaveLength(1);
    // Uma chamada do lote + uma por vaga.
    expect(p.state.calls).toBe(11);
  });

  it('the one-by-one calls respect the daily budget: once it is spent, the rest waits for the next day', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    await seedJobs(10, poison);
    const p = counting(async (req, call) => {
      if (req.prompt.includes('POISON-MARKER')) throw new AiError('refused', 'o modelo recusou o pedido');
      // A segunda chamada individual gasta o orçamento do dia inteiro.
      if (call === 3) {
        await recordUsage(db, { provider: 'fake', model: 'fake-fast', layer: 'tier1', inputTokens: 1, outputTokens: 1, costUsd: 5, createdAt: clock });
      }
    });
    const queue = queueWith(p.provider);
    await queue.drain();
    expect(p.state.calls).toBe(3);
    const rows = await tasks();
    expect(rows.filter((t) => t.status === 'ok')).toHaveLength(2);
    expect(rows.filter((t) => t.status === 'blocked_budget')).toHaveLength(8);
    expect(await states()).toEqual(['ok', 'ok']);
  });
});

describe('the sweep retries jobs whose tier 1 failed', () => {
  async function failed(jobId: number, finishedAt: number, times = 1) {
    await db.insert(jobAi).values({ jobId, tier1State: 'error' }).onConflictDoNothing();
    for (let i = 0; i < times; i++) {
      await db.insert(aiTasks).values({
        type: 'tier1', subject: `job:${jobId}`, jobId, status: 'error', attempts: 3, error: 'x', createdAt: finishedAt - 1000, finishedAt,
      });
    }
  }

  it('picks a failure that is old enough, leaves a recent one, and stops after the cap of failures', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    const [old, recent, capped, archived, legacy] = await seedJobs(5, (i) => (i === 3 ? { column: 'arquivada' } : {}));
    await failed(old.id, NOW - TIER1_RETRY_AFTER_MS - HOUR);
    await failed(recent.id, NOW - HOUR);
    await failed(capped.id, NOW - 10 * TIER1_RETRY_AFTER_MS, TIER1_MAX_FAILURES);
    await failed(archived.id, NOW - 10 * TIER1_RETRY_AFTER_MS);
    // Erro antigo sem nenhuma tarefa guardada (as tarefas terminadas são apagadas depois de 30 dias).
    await db.insert(jobAi).values({ jobId: legacy.id, tier1State: 'error' });

    expect(await enqueueTier1ForNewJobs(db, 50, NOW)).toBe(2);
    const queued = (await tasks()).filter((t) => t.status === 'queued').map((t) => t.jobId);
    expect(queued.sort()).toEqual([old.id, legacy.id].sort());
    // Idempotente: quem já tem tarefa pendente não entra de novo.
    expect(await enqueueTier1ForNewJobs(db, 50, NOW)).toBe(0);
  });

  it('end to end: a failure that stops happening is scored on a later sweep', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    await seedJobs(1);
    let broken = true;
    const p = counting(() => {
      if (broken) throw new AiError('refused', 'o modelo recusou o pedido');
    });
    const queue = queueWith(p.provider);
    await queue.drain();
    expect(await states()).toEqual(['error']);
    broken = false;
    await queue.drain();
    expect(await states()).toEqual(['error']);
    clock += TIER1_RETRY_AFTER_MS + HOUR;
    await queue.drain();
    expect(await states()).toEqual(['ok']);
  });
});

describe('tasks left running by a process that died', () => {
  const strongConfig: AiConfig = { ...config, models: { fast: 'claude-haiku-5-5', strong: 'claude-opus-5-5' } };

  it('start-up recovery counts the attempt, respects the cap and records a conservative estimated usage', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    const [a, b] = await seedJobs(2);
    for (const j of [a, b]) await enqueueAiTask(db, { type: 'tier2', jobId: j.id }, NOW);
    const [first, second] = await tasks();
    await db.update(aiTasks).set({ status: 'running', attempts: 1, startedAt: NOW - 1000 }).where(eq(aiTasks.id, first.id));
    await db.update(aiTasks).set({ status: 'running', attempts: 3, startedAt: NOW - 1000 }).where(eq(aiTasks.id, second.id));
    const p = counting();
    const queue = queueWith(p.provider, { sweep: undefined }, strongConfig);

    expect(await queue.recoverInterrupted()).toBe(2);
    const rows = await tasks();
    // A tentativa interrompida conta: a primeira tarefa volta com 1 tentativa gasta, a segunda acabou as três.
    expect(rows[0]).toMatchObject({ status: 'queued', attempts: 1, error: 'execução interrompida' });
    expect(rows[1]).toMatchObject({ status: 'error', attempts: 3, error: 'execução interrompida' });
    expect((await db.select().from(jobAi).where(eq(jobAi.jobId, b.id)))[0]).toMatchObject({ tier2State: 'error' });

    const usage = await db.select().from(aiUsage).orderBy(asc(aiUsage.id));
    const estimate = estimateInterruptedUsage('tier2');
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      layer: 'tier2', model: `claude-opus-5-5${ESTIMATED_MODEL_SUFFIX}`, inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens,
    });
    expect(usage[0].costUsd).toBeCloseTo((estimate.inputTokens * 4 + estimate.outputTokens * 20) / 1_000_000, 6);
    expect(p.state.calls).toBe(0);
  });

  it('a task that kills the process every time stops after the third attempt instead of looping', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job.id }, NOW);
    for (let boot = 1; boot <= 3; boot++) {
      // O processo "morre" com a tarefa em execução (a fila contou a tentativa ao iniciar) e sobe de novo.
      await db.update(aiTasks).set({ status: 'running', attempts: boot, startedAt: clock, runAfter: null });
      await queueWith(counting().provider, { sweep: undefined }).recoverInterrupted();
    }
    expect((await tasks())[0]).toMatchObject({ status: 'error', attempts: 3 });
  });
});

describe('a strong call that is aborted by the time limit', () => {
  const strongConfig: AiConfig = { ...config, models: { fast: 'claude-haiku-5-5', strong: 'claude-opus-5-5' } };
  /** Como os adaptadores de verdade: a chamada fica presa até o sinal abortar e então rejeita sem uso. */
  const hanging = () => {
    const state = { calls: 0, requests: [] as AiRequest<unknown>[] };
    const provider: AiProvider = {
      id: 'fake',
      generate: (req) =>
        new Promise((_, reject) => {
          state.calls++;
          state.requests.push(req as AiRequest<unknown>);
          req.signal?.addEventListener('abort', () => reject(new AiError('transient', 'chamada cancelada (tempo esgotado)', 'timeout')));
        }),
    };
    return { provider, state };
  };

  it('records an estimated usage row (input from the prompt, output at the cap) so the budget sees it', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job.id }, NOW);
    const p = hanging();
    const queue = queueWith(p.provider, { sweep: undefined, timeoutMs: { tier2: 30 }, abortGraceMs: 200, backoffMs: [60_000] }, strongConfig);
    await queue.tick();
    await queue.idle();
    const [row] = await db.select().from(aiUsage);
    const req = p.state.requests[0];
    expect(row).toMatchObject({
      layer: 'tier2', model: `claude-opus-5-5${ESTIMATED_MODEL_SUFFIX}`,
      inputTokens: Math.ceil((req.system.length + req.prompt.length) / 3),
      // 8 000 visíveis + 8 000 de raciocínio: o teto de saída da chamada.
      outputTokens: 16_000,
    });
    expect(row.costUsd).toBeGreaterThan(0.32);
    expect((await tasks())[0]).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('is retried at most once', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job.id }, NOW);
    const p = hanging();
    // Orçamento alto: aqui o que limita é a regra de uma nova tentativa, não o gasto estimado.
    const queue = queueWith(p.provider, { sweep: undefined, timeoutMs: { tier2: 30 }, abortGraceMs: 200 }, { ...strongConfig, dailyBudgetUsd: 100 });
    await queue.drain();
    expect(p.state.calls).toBe(2);
    expect((await tasks())[0]).toMatchObject({ status: 'error', attempts: 2, error: expect.stringContaining('tempo esgotado') });
    expect(await db.select().from(aiUsage)).toHaveLength(2);
  });
});

describe('a profile task that finishes after the user edited the profile', () => {
  const edited = { ...SAMPLE_PROFILE, summary: 'EDITED BY THE USER while the task was waiting' };

  it('"Traduzir de novo" does not overwrite the edit: the task fails with a fixed message', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    await saveProfile(db, 'en', SAMPLE_PROFILE, 'traduzido', NOW);
    await enqueueAiTask(db, { type: 'profile_translate', lang: 'en' }, NOW);
    const saved = await saveProfile(db, 'en', edited, 'editado', NOW);
    const p = counting();
    await queueWith(p.provider, { sweep: undefined }).drain();
    const now = await profileFor(db, 'en');
    expect(now).toMatchObject({ version: saved.version, origin: 'editado' });
    expect(now!.data.summary).toContain('EDITED BY THE USER');
    expect((await tasks())[0]).toMatchObject({ status: 'error', attempts: 1, error: PROFILE_CHANGED_ERROR });
    expect(p.state.calls).toBe(1);
  });

  it('a re-upload extraction does not overwrite an edit saved after the upload, but replaces one saved before it', async () => {
    const { resumes } = await import('@kv/db');
    const { SAMPLE_RESUME_TEXT } = await import('@kv/ai/testing');
    await db.insert(resumes).values({ lang: 'pt-BR', fileName: 'cv.pdf', mime: 'application/pdf', content: Buffer.from('x'), extractedText: SAMPLE_RESUME_TEXT, uploadedAt: NOW });
    // Editado ANTES do envio: o usuário confirmou a substituição ao enviar.
    await saveProfile(db, 'pt-BR', edited, 'editado', NOW - 1000);
    await enqueueAiTask(db, { type: 'profile_extract', lang: 'pt-BR' }, NOW);
    await queueWith(counting().provider, { sweep: undefined }).drain();
    expect(await profileFor(db, 'pt-BR')).toMatchObject({ origin: 'extraido' });

    // Editado DEPOIS do envio, com a extração ainda na fila.
    await enqueueAiTask(db, { type: 'profile_extract', lang: 'pt-BR' }, NOW);
    clock = NOW + 5000;
    const saved = await saveProfile(db, 'pt-BR', edited, 'editado', clock);
    await queueWith(counting().provider, { sweep: undefined }).drain();
    expect(await profileFor(db, 'pt-BR')).toMatchObject({ origin: 'editado', version: saved.version });
    expect((await tasks()).at(-1)).toMatchObject({ status: 'error', error: PROFILE_CHANGED_ERROR });
  });

  it('a task whose row was deleted (the user deleted the data) writes nothing', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
    await enqueueAiTask(db, { type: 'profile_translate', lang: 'en' }, NOW);
    const p = counting(async () => {
      await db.delete(aiTasks);
    });
    await queueWith(p.provider, { sweep: undefined }).drain();
    expect(await profileFor(db, 'en')).toBeNull();
  });
});

describe('retention of finished tasks', () => {
  it('prunes ok and error tasks older than the retention, never pending ones', async () => {
    const [a, b, c] = await seedJobs(3);
    const DAY = 24 * HOUR;
    await db.insert(aiTasks).values([
      { type: 'tier2', subject: `job:${a.id}`, jobId: a.id, status: 'ok', createdAt: NOW - 40 * DAY, finishedAt: NOW - 40 * DAY },
      { type: 'tier2', subject: `job:${b.id}`, jobId: b.id, status: 'error', createdAt: NOW - 40 * DAY, finishedAt: NOW - 31 * DAY },
      { type: 'tier2', subject: `job:${c.id}`, jobId: c.id, status: 'ok', createdAt: NOW - 40 * DAY, finishedAt: NOW - 2 * DAY },
      { type: 'tier1', subject: `job:${a.id}`, jobId: a.id, status: 'queued', createdAt: NOW - 40 * DAY },
    ]);
    expect(await pruneAiTasks(db, NOW - 30 * DAY)).toBe(2);
    expect((await tasks()).map((t) => `${t.type}:${t.status}`)).toEqual(['tier2:ok', 'tier1:queued']);

    // A fila faz a limpeza sozinha (no máximo uma vez por hora).
    await db.update(aiTasks).set({ finishedAt: NOW - 31 * DAY }).where(eq(aiTasks.status, 'ok'));
    const queue = queueWith(counting().provider, { sweep: undefined, maxConcurrent: 0 });
    expect((await queue.tick()).pruned).toBe(1);
    expect((await queue.tick()).pruned).toBe(0);
  });
});
