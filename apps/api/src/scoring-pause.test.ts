import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiTasks, closeDb, providerWait, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { TEST_SECRET, seedJob, testAi } from './ai-testing';
import { buildApp } from './app';

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);
const MESSAGE = 'a chave de API da OpenAI é inválida ou não tem permissão';

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi({ env: { AI_PROVIDER: 'fake', AI_ALLOW_FAKE: '1', APP_SECRET: TEST_SECRET } }) });
});
afterAll(() => closeDb(db));

/** O que a fila do worker grava quando o provedor recusa a chave no meio da triagem. */
async function pauseScoring(n = 2) {
  for (let i = 0; i < n; i++) {
    const job = await seedJob(db, { externalId: `p${i}` });
    await db.insert(aiTasks).values({
      type: 'tier1', subject: `job:${job.id}`, jobId: job.id, status: 'queued', attempts: 0, error: MESSAGE, createdAt: NOW,
      runAfter: NOW + 30 * 60_000,
    });
  }
}
const status = async () => (await app.inject({ method: 'GET', url: '/api/ai/status' })).json();

describe('AI status says why automatic scoring is paused', () => {
  it('is null while nothing is waiting for the provider', async () => {
    const job = await seedJob(db);
    // Tarefa comum na fila e tarefa esperando uma nova tentativa normal: nenhuma delas é pausa do provedor.
    await db.insert(aiTasks).values([
      { type: 'tier1', subject: `job:${job.id}`, jobId: job.id, status: 'queued', attempts: 0, createdAt: NOW },
      { type: 'tier2', subject: `job:${job.id}`, jobId: job.id, status: 'queued', attempts: 1, error: 'falha de rede', createdAt: NOW, runAfter: NOW + 30_000 },
    ]);
    expect((await status()).scoringPause).toBeNull();
  });

  it('reports the provider message, when the queue tries again, and how many tasks wait', async () => {
    await pauseScoring(3);
    expect((await status()).scoringPause).toEqual({ message: MESSAGE, retryAt: NOW + 30 * 60_000, tasks: 3 });
  });
});

describe('fixing the AI configuration on the screen resumes scoring at once', () => {
  const waiting = async () => (await providerWait(db, NOW))?.tasks ?? 0;

  it('saving a key releases the waiting tasks', async () => {
    await pauseScoring();
    const res = await app.inject({ method: 'PUT', url: '/settings/ai-keys/openai', payload: { key: 'sk-test-uma-chave-ficticia-0001' } });
    expect(res.statusCode).toBe(200);
    expect(await waiting()).toBe(0);
    expect(await db.select().from(aiTasks)).toMatchObject([
      { status: 'queued', error: null, runAfter: null }, { status: 'queued', error: null, runAfter: null },
    ]);
  });

  it('changing provider or model releases them; a change that has nothing to do with the provider does not', async () => {
    await pauseScoring();
    expect((await app.inject({ method: 'PATCH', url: '/settings', payload: { dailyBudgetUsd: 2 } })).statusCode).toBe(200);
    expect(await waiting()).toBe(2);
    expect((await app.inject({ method: 'PATCH', url: '/settings', payload: { modelFast: 'fake-fast' } })).statusCode).toBe(200);
    expect(await waiting()).toBe(0);
  });

  it('a successful "Testar conexão" releases them', async () => {
    await pauseScoring();
    const res = await app.inject({ method: 'POST', url: '/settings/ai/test' });
    expect(res.json()).toMatchObject({ outcome: 'ok' });
    expect(await waiting()).toBe(0);
  });
});
