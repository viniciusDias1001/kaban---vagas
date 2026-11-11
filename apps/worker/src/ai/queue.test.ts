import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { AiError } from '@kv/ai';
import type { Connector } from '@kv/connectors';
import {
  aiTasks, closeDb, confirmAiTask, enqueueAiTask, enqueueRuns, jobs, recordUsage, runs, searchProfiles, type AiTaskRow,
  type Db,
} from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { createQueue } from '../scheduler';
import { createAiQueue, type AiQueueOptions, type AiQueueSettings, type UnitRunner } from './queue';
import { UNKNOWN_TASK_ERROR } from './task-errors';

const TZ = 'America/Sao_Paulo';
/** 2026-11-11 12:00 em São Paulo. */
const NOON = Date.UTC(2026, 10, 11, 15, 0, 0);
const DAY = 86_400_000;

let db: Db;
let clock: number;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  clock = NOON;
  live = { enabled: true, dailyBudgetUsd: 1, budgetTimeZone: TZ, sweepEnabled: true };
});
afterAll(() => closeDb(db));

async function seedJobs(n: number): Promise<number[]> {
  const rows = await db
    .insert(jobs)
    .values(
      Array.from({ length: n }, (_, i) => ({
        source: 'gupy', externalId: String(i), url: `https://example.com/${i}`, title: `Dev ${i}`, company: 'Acme',
        location: '', country: 'BR' as const, remote: true, stacks: [], description: '', postedAt: null, discoveredAt: 1,
        dedupHash: String(i), profileId: null, position: i,
      })),
    )
    .returning({ id: jobs.id });
  return rows.map((r) => r.id);
}

/** As configurações "ao vivo": os testes mudam este objeto como a aba Configurações mudaria o banco. */
let live: AiQueueSettings;
const options = (over: Partial<AiQueueOptions> = {}): AiQueueOptions => ({
  settings: async () => live, now: () => clock, ...over,
});
const spend = (costUsd: number, createdAt = clock) =>
  recordUsage(db, { provider: 'fake', model: 'fake-fast', layer: 'tier1', inputTokens: 1, outputTokens: 1, costUsd, createdAt });
const all = () => db.select().from(aiTasks).orderBy(asc(aiTasks.id));
const statuses = async () => (await all()).map((t) => `${t.type}:${t.status}`);

/** Runner que registra as unidades recebidas e responde o que o teste mandar. */
function recorder(reply: (tasks: AiTaskRow[]) => Map<number, unknown> | void = () => {}) {
  const units: string[][] = [];
  const run: UnitRunner = async (tasks) => {
    units.push(tasks.map((t) => `${t.type}:${t.jobId ?? t.lang}`));
    return reply(tasks);
  };
  return { run, units };
}

/** Runner que fica preso até `release()`; guarda o sinal de cada unidade. */
function gated() {
  const waiting: (() => void)[] = [];
  const signals: AbortSignal[] = [];
  const run: UnitRunner = async (_tasks, signal) => {
    signals.push(signal);
    await new Promise<void>((r) => waiting.push(r));
  };
  return { run, signals, release: () => waiting.shift()?.(), pending: () => waiting.length };
}

const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 2_000 && !(await condition()); i++) await new Promise((r) => setTimeout(r, 2));
  expect(await condition()).toBe(true);
};

describe('createAiQueue', () => {
  it('runs queued tasks and marks them ok', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job });
    const { run, units } = recorder();
    const queue = createAiQueue(db, run, options());
    expect(await queue.drain()).toBe(1);
    expect(units).toEqual([[`tier2:${job}`]]);
    expect((await all())[0]).toMatchObject({ status: 'ok', attempts: 1, error: null, startedAt: NOON, finishedAt: NOON });
    expect(await queue.drain()).toBe(0);
  });

  it('batches tier 1 (10 per call) and serves user requests first', async () => {
    const ids = await seedJobs(12);
    for (const id of ids) await enqueueAiTask(db, { type: 'tier1', jobId: id });
    await enqueueAiTask(db, { type: 'tier2', jobId: ids[0] });
    await enqueueAiTask(db, { type: 'tier3', jobId: ids[0] });
    await enqueueAiTask(db, { type: 'profile_extract', lang: 'en' });
    const { run, units } = recorder();
    await createAiQueue(db, run, options({ maxConcurrent: 1 })).drain();
    expect(units.map((u) => u.length)).toEqual([1, 1, 1, 10, 2]);
    expect(units.slice(0, 3).map((u) => u[0])).toEqual(['profile_extract:en', `tier3:${ids[0]}`, `tier2:${ids[0]}`]);
    expect(units[3]).toEqual(ids.slice(0, 10).map((id) => `tier1:${id}`));
    expect(new Set(await statuses())).toEqual(new Set(['tier1:ok', 'tier2:ok', 'tier3:ok', 'profile_extract:ok']));
  });

  it('never waits for a call: at most two units at once, and tick returns while they run', async () => {
    const ids = await seedJobs(3);
    for (const id of ids) await enqueueAiTask(db, { type: 'tier2', jobId: id });
    const gate = gated();
    const queue = createAiQueue(db, gate.run, options());
    expect((await queue.tick()).started).toBe(2);
    await until(() => gate.pending() === 2);
    expect(queue.inFlightIds()).toHaveLength(2);
    expect((await queue.tick()).started).toBe(0);
    expect(await statuses()).toEqual(['tier2:running', 'tier2:running', 'tier2:queued']);
    gate.release();
    await until(async () => (await statuses()).includes('tier2:ok'));
    expect((await queue.tick()).started).toBe(1);
    gate.release();
    gate.release();
    await queue.idle();
    expect(await statuses()).toEqual(['tier2:ok', 'tier2:ok', 'tier2:ok']);
  });

  it('retries a failure with growing waits and gives up after the third attempt', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job });
    const failed: string[] = [];
    const { run } = recorder(() => {
      throw new AiError('transient', 'falha de rede');
    });
    const queue = createAiQueue(db, run, options({ onFailed: async (task, message) => void failed.push(`${task.type}:${message}`) }));

    await queue.drain();
    expect((await all())[0]).toMatchObject({ status: 'queued', attempts: 1, error: 'falha de rede', runAfter: NOON + 30_000 });
    clock += 29_000;
    expect(await queue.drain()).toBe(0);
    clock += 1_000;
    await queue.drain();
    expect((await all())[0]).toMatchObject({ status: 'queued', attempts: 2, runAfter: clock + 120_000 });
    clock += 120_000;
    await queue.drain();
    expect((await all())[0]).toMatchObject({ status: 'error', attempts: 3, error: 'falha de rede', finishedAt: clock });
    expect(failed).toEqual(['tier2:falha de rede']);
    // Depois de falhar de vez, o mesmo alvo pode ser pedido de novo.
    expect(await enqueueAiTask(db, { type: 'tier2', jobId: job })).toBeTypeOf('number');
  });

  it('waits twice as long after a rate limit and does not retry a configuration error', async () => {
    const [a, b] = await seedJobs(2);
    await enqueueAiTask(db, { type: 'tier2', jobId: a });
    await enqueueAiTask(db, { type: 'tier3', jobId: b });
    const { run } = recorder((tasks) => {
      throw tasks[0].type === 'tier2' ? new AiError('rate_limited', 'limite de taxa') : new AiError('config', 'chave inválida');
    });
    await createAiQueue(db, run, options()).drain();
    const [tier2, tier3] = await all();
    expect(tier2).toMatchObject({ status: 'queued', attempts: 1, runAfter: NOON + 60_000 });
    expect(tier3).toMatchObject({ status: 'error', attempts: 1, error: 'chave inválida' });
  });

  it('fails only the tasks of a batch that the runner reports', async () => {
    const ids = await seedJobs(3);
    for (const id of ids) await enqueueAiTask(db, { type: 'tier1', jobId: id });
    const { run } = recorder((tasks) => new Map([[tasks[1].id, new AiError('invalid_output', 'sem resultado para esta vaga')]]));
    await createAiQueue(db, run, options()).drain();
    expect(await statuses()).toEqual(['tier1:ok', 'tier1:queued', 'tier1:ok']);
    expect((await all())[1]).toMatchObject({ attempts: 1, error: 'sem resultado para esta vaga' });
  });

  it('aborts a call that exceeds the time limit and retries it later', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job });
    const gate = gated();
    const queue = createAiQueue(db, gate.run, options({ timeoutMs: { tier2: 30 }, abortGraceMs: 10 }));
    await queue.tick();
    await queue.idle();
    expect(gate.signals[0].aborted).toBe(true);
    expect((await all())[0]).toMatchObject({ status: 'queued', attempts: 1, error: expect.stringContaining('tempo esgotado') });
  });

  it('returns abandoned running tasks to the queue, and closes them once out of attempts', async () => {
    const [a, b, c] = await seedJobs(3);
    for (const id of [a, b, c]) await enqueueAiTask(db, { type: 'tier2', jobId: id });
    const [first, second, third] = await all();
    await db.update(aiTasks).set({ status: 'running', attempts: 1, startedAt: clock - 30 * 60_000 }).where(eq(aiTasks.id, first.id));
    await db.update(aiTasks).set({ status: 'running', attempts: 3, startedAt: clock - 30 * 60_000 }).where(eq(aiTasks.id, second.id));
    await db.update(aiTasks).set({ status: 'running', attempts: 1, startedAt: clock - 5_000 }).where(eq(aiTasks.id, third.id));
    const queue = createAiQueue(db, recorder().run, options({ maxConcurrent: 0 }));
    expect((await queue.tick()).requeued).toBe(2);
    expect((await all()).map((t) => t.status)).toEqual(['queued', 'error', 'running']);
    expect((await all())[1].error).toBe('execução interrompida');

    // No start do worker toda tarefa "running" é de um processo que morreu, por mais recente que seja.
    expect(await queue.recoverInterrupted()).toBe(1);
    expect((await all())[2]).toMatchObject({ status: 'queued', attempts: 1, error: 'execução interrompida' });
  });

  it('does not throw from tick when the runner breaks in an unexpected way', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job });
    const logged: string[] = [];
    const queue = createAiQueue(db, async () => Promise.reject('texto, não Error'), options({ log: (m) => logged.push(m) }));
    await queue.drain();
    // O que não é AiError não vai para o banco: a tela recebe a frase fixa e o detalhe fica no log.
    expect((await all())[0]).toMatchObject({ status: 'queued', attempts: 1, error: UNKNOWN_TASK_ERROR });
    expect(logged.join('\n')).toContain('texto, não Error');
  });

  it('keeps a database error (SQL text, parameters) out of ai_tasks.error and logs it without the parameters', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job });
    const logged: string[] = [];
    const failed: string[] = [];
    const dbError = Object.assign(
      new Error('Failed query: insert into "job_ai" ("job_id", "analysis") values ($1, $2)\nparams: 7,{"resumo":"texto do currículo"}'),
      { cause: Object.assign(new Error('relation "job_ai" does not exist'), { code: '42P01' }) },
    );
    const queue = createAiQueue(db, async () => Promise.reject(dbError), options({
      maxAttempts: 1, log: (m) => logged.push(m), onFailed: async (_task, message) => void failed.push(message),
    }));
    await queue.drain();
    const [task] = await all();
    expect(task).toMatchObject({ status: 'error', attempts: 1, error: UNKNOWN_TASK_ERROR });
    expect(task.error).not.toMatch(/insert|job_ai|currículo/);
    expect(failed).toEqual([UNKNOWN_TASK_ERROR]);
    const line = logged.join('\n');
    expect(line).toContain(`tarefa ${task.id} (tier2)`);
    expect(line).toContain('Failed query: insert into "job_ai"');
    expect(line).toContain('[42P01]: relation "job_ai" does not exist');
    expect(line).not.toContain('texto do currículo');
  });
});

describe('daily budget', () => {
  it('pauses tier 1 when the limit of the day is reached and makes no automatic call', async () => {
    const ids = await seedJobs(2);
    for (const id of ids) await enqueueAiTask(db, { type: 'tier1', jobId: id });
    await spend(1);
    let swept = 0;
    const { run, units } = recorder();
    const queue = createAiQueue(db, run, options({ sweep: async () => ++swept }));
    expect(await queue.tick()).toMatchObject({ started: 0, blocked: 2 });
    expect(await statuses()).toEqual(['tier1:blocked_budget', 'tier1:blocked_budget']);
    expect(units).toEqual([]);
    expect(swept).toBe(0);
    // Continua pausada nas verificações seguintes do mesmo dia.
    clock += 6 * 3_600_000;
    expect((await queue.tick()).started).toBe(0);
    expect(units).toEqual([]);
  });

  it('holds tiers 2 and 3 and profile tasks until the user confirms each one', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job });
    await enqueueAiTask(db, { type: 'tier3', jobId: job });
    await enqueueAiTask(db, { type: 'profile_translate', lang: 'en' });
    await spend(1.2);
    const { run, units } = recorder();
    const queue = createAiQueue(db, run, options());
    await queue.drain();
    expect(await statuses()).toEqual(['tier2:blocked_budget', 'tier3:blocked_budget', 'profile_translate:blocked_budget']);
    expect(units).toEqual([]);

    const tier3 = (await all())[1];
    expect(await confirmAiTask(db, tier3.id)).toBe(true);
    await queue.drain();
    expect(units).toEqual([[`tier3:${job}`]]);
    expect(await statuses()).toEqual(['tier2:blocked_budget', 'tier3:ok', 'profile_translate:blocked_budget']);
  });

  it('resumes everything on the next day of the budget time zone', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier1', jobId: job });
    await enqueueAiTask(db, { type: 'tier2', jobId: job });
    await spend(1);
    let swept = 0;
    const { run, units } = recorder();
    const queue = createAiQueue(db, run, options({ sweep: async () => ++swept }));
    await queue.drain();
    expect(units).toEqual([]);

    // 23:59 em São Paulo (02:59 UTC do dia 12): ainda é o mesmo dia.
    clock = Date.UTC(2026, 10, 12, 2, 59, 0);
    await queue.drain();
    expect(units).toEqual([]);

    // 00:01 em São Paulo: dia novo, gasto zerado.
    clock = Date.UTC(2026, 10, 12, 3, 1, 0);
    expect(await queue.tick()).toMatchObject({ released: 2, started: 2 });
    await queue.idle();
    expect(units.map((u) => u[0]).sort()).toEqual([`tier1:${job}`, `tier2:${job}`]);
    expect(swept).toBe(1);
  });

  it('counts only the spending of the current day and runs normally under the limit', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier1', jobId: job });
    await spend(5, NOON - DAY);
    await spend(0.99);
    const { run, units } = recorder();
    await createAiQueue(db, run, options()).drain();
    expect(units).toHaveLength(1);
  });

  it('with a budget of zero nothing runs without confirmation', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier1', jobId: job });
    const { run, units } = recorder();
    live.dailyBudgetUsd = 0;
    await createAiQueue(db, run, options()).drain();
    expect(units).toEqual([]);
    expect(await statuses()).toEqual(['tier1:blocked_budget']);
  });
});

describe('settings are read on every check, without restarting the worker', () => {
  it('starts nothing while AI is not configured, and picks the queue up as soon as it is', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job });
    live.enabled = false;
    let swept = 0;
    const { run, units } = recorder();
    const queue = createAiQueue(db, run, options({ sweep: async () => ++swept }));
    expect(await queue.tick()).toMatchObject({ started: 0, blocked: 0, swept: 0 });
    expect(await statuses()).toEqual(['tier2:queued']);
    expect(swept).toBe(0);
    // O usuário escolhe o provedor e grava a chave na aba Configurações: a mesma fila passa a rodar.
    live.enabled = true;
    await queue.drain();
    expect(units).toEqual([[`tier2:${job}`]]);
    expect(swept).toBeGreaterThan(0);
  });

  it('with the automatic triage off the sweep does not run, but a requested tier 1 still does', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier1', jobId: job });
    live.sweepEnabled = false;
    let swept = 0;
    const { run, units } = recorder();
    await createAiQueue(db, run, options({ sweep: async () => ++swept })).drain();
    expect(swept).toBe(0);
    expect(units).toEqual([[`tier1:${job}`]]);
  });

  it('applies a new daily budget on the next check', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier1', jobId: job });
    await spend(1);
    const { run, units } = recorder();
    const queue = createAiQueue(db, run, options());
    await queue.drain();
    expect(await statuses()).toEqual(['tier1:blocked_budget']);
    live.dailyBudgetUsd = 5;
    await queue.drain();
    expect(units).toHaveLength(1);
  });
});

describe('the AI queue never delays the job search', () => {
  it('a hanging AI call does not stop the job-fetch queue from finishing its runs', async () => {
    const [job] = await seedJobs(1);
    await enqueueAiTask(db, { type: 'tier2', jobId: job });
    const gate = gated();
    const ai = createAiQueue(db, gate.run, options());
    await ai.tick();
    await until(() => gate.pending() === 1);

    const [profile] = await db
      .insert(searchProfiles)
      .values({ name: 'P', stacks: [], levels: [], maxAgeDays: 7, regions: [], sources: ['a'], active: true, createdAt: 1 })
      .returning();
    await enqueueRuns(db, profile, 'manual');
    const connector: Connector = {
      id: 'a', name: 'A',
      search: async () => [{
        source: 'a', externalId: 'x', url: 'https://example.com/novo', title: 'Dev', company: 'Outra', location: '',
        country: 'BR', remote: true, stacks: [], description: '', postedAt: null,
      }],
    };
    expect(await createQueue(db, () => [connector]).drain()).toBe(1);
    expect((await db.select().from(runs))[0].status).toBe('ok');
    expect(ai.inFlightIds()).toHaveLength(1);

    gate.release();
    await ai.idle();
  });
});
