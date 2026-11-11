import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import { aiTasks, closeDb, jobAi, saveProfile, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { seedJob, testAi } from './ai-testing';
import { buildApp } from './app';

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi() });
});
afterAll(() => closeDb(db));

const pending = async () => (await db.select().from(aiTasks)).filter((t) => t.status === 'queued').map((t) => t.type).sort();
/** O que o painel da vaga manda ao abrir (sem corpo) e o que os botões mandam (`explicit: true`). */
const open = (id: number) => app.inject({ method: 'POST', url: `/jobs/${id}/ai/analyze` });
const click = (id: number) => app.inject({ method: 'POST', url: `/api/jobs/${id}/ai/analyze`, payload: { explicit: true } });

/** Uma vaga cuja análise (camada 2) falhou de vez: a resposta do modelo foi cortada, por exemplo. */
async function failedAnalysis() {
  const profile = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
  const job = await seedJob(db);
  await db.insert(jobAi).values({
    jobId: job.id, language: 'pt', titlePt: 'Dev React', score: 70, reason: 'r', tier1State: 'ok',
    tier1ProfileVersion: profile.version, tier2State: 'error',
  });
  await db.insert(aiTasks).values({
    type: 'tier2', subject: `job:${job.id}`, jobId: job.id, status: 'error', attempts: 1, error: 'resposta cortada pelo limite de tokens',
    createdAt: 1, finishedAt: 2,
  });
  return job;
}

describe('a layer that ended in error is only run again when the user asks', () => {
  it('opening the job again (and again) queues nothing: no paid call is repeated', async () => {
    const job = await failedAnalysis();
    for (let i = 0; i < 4; i++) {
      const res = await open(job.id);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ queued: [], reason: 'previous_error' });
    }
    expect(await pending()).toEqual([]);
  });

  it('moving the card to Selecionadas queues nothing either', async () => {
    const job = await failedAnalysis();
    const res = await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { column: 'selecionadas', position: 1 } });
    expect(res.statusCode).toBe(200);
    expect(await pending()).toEqual([]);
  });

  it('the stored error stays visible on the job, with the task that failed', async () => {
    const job = await failedAnalysis();
    await open(job.id);
    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}/ai` })).json();
    expect(detail.tier2).toMatchObject({ state: 'error', task: { status: 'error', error: 'resposta cortada pelo limite de tokens' } });
  });

  it('"Tentar de novo" (explicit) runs it again, once', async () => {
    const job = await failedAnalysis();
    const res = await click(job.id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: ['tier2'], reason: null });
    expect((await click(job.id)).json()).toEqual({ queued: [], reason: null });
    expect(await pending()).toEqual(['tier2']);
  });

  it('a failed tier 1 is also left alone by automatic triggers (the worker sweep retries it later), but tier 2 still runs', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const job = await seedJob(db);
    await db.insert(jobAi).values({ jobId: job.id, tier1State: 'error' });
    expect((await open(job.id)).json()).toEqual({ queued: ['tier2'], reason: null });
    expect((await click(job.id)).json()).toEqual({ queued: ['tier1'], reason: null });
  });

  it('a first open still queues both layers, and the body is validated', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const job = await seedJob(db);
    expect((await open(job.id)).json()).toEqual({ queued: ['tier1', 'tier2'], reason: null });
    const bad = await app.inject({ method: 'POST', url: `/jobs/${job.id}/ai/analyze`, payload: { explicit: 'sim' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /jobs/ai (the board list, every 15 s)', () => {
  it('has no justification text and skips archived jobs; the per-job route still has the reason', async () => {
    const profile = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const shown = await seedJob(db, { externalId: 'a' });
    const archived = await seedJob(db, { externalId: 'b', column: 'arquivada' });
    for (const job of [shown, archived]) {
      await db.insert(jobAi).values({
        jobId: job.id, language: 'en', titlePt: 'Pessoa desenvolvedora', score: 82, reason: 'React e TypeScript aparecem na vaga.',
        tier1State: 'ok', tier1ProfileVersion: profile.version,
      });
    }
    const list = (await app.inject({ method: 'GET', url: '/api/jobs/ai' })).json();
    expect(list).toEqual([{ jobId: shown.id, language: 'en', titlePt: 'Pessoa desenvolvedora', score: 82, stale: false }]);
    const detail = (await app.inject({ method: 'GET', url: `/jobs/${shown.id}/ai` })).json();
    expect(detail.summary.reason).toBe('React e TypeScript aparecem na vaga.');
  });
});
