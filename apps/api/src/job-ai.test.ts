import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import { aiTasks, closeDb, jobAi, saveProfile, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import type { JobAnalysis } from '@kv/shared';
import { NO_AI_ENV, seedJob, testAi } from './ai-testing';
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

const analysis: JobAnalysis = {
  strengths: ['React'], gaps: [], keywordsPresent: ['React'], keywordsMissing: ['Go'], interviewTopics: ['hooks'],
  likelyQuestions: ['Conte sobre um projeto.'],
};
const taskTypes = async () => (await db.select().from(aiTasks)).map((t) => `${t.type}:${t.status}`).sort();
const analyze = (id: number | string) => app.inject({ method: 'POST', url: `/jobs/${id}/ai/analyze` });
const detail = async (id: number) => (await app.inject({ method: 'GET', url: `/jobs/${id}/ai` })).json();

describe('POST /jobs/:id/ai/analyze (opening a job)', () => {
  it('queues tier 1 and tier 2 once, and nothing while they are pending', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const job = await seedJob(db);
    const res = await analyze(job.id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: ['tier1', 'tier2'], reason: null });
    expect((await analyze(job.id)).json()).toEqual({ queued: [], reason: null });
    expect(await taskTypes()).toEqual(['tier1:queued', 'tier2:queued']);
  });

  it('never processes the same job twice with the same profile, and redoes it when the profile changes', async () => {
    const profile = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const job = await seedJob(db);
    await db.insert(jobAi).values({
      jobId: job.id, language: 'pt', titlePt: 'Dev React', score: 70, reason: 'r', tier1State: 'ok',
      tier1ProfileVersion: profile.version, analysis, tier2State: 'ok', tier2ProfileVersion: profile.version,
    });
    expect((await analyze(job.id)).json()).toEqual({ queued: [], reason: null });
    expect(await taskTypes()).toEqual([]);

    await saveProfile(db, 'pt-BR', { ...SAMPLE_PROFILE, summary: 'Mudou.' }, 'editado');
    expect((await detail(job.id)).tier1.state).toBe('stale');
    expect((await analyze(job.id)).json()).toEqual({ queued: ['tier1', 'tier2'], reason: null });
  });

  it('does nothing without a profile, answers 409 without a provider and 404 for an unknown job', async () => {
    const job = await seedJob(db);
    expect((await analyze(job.id)).json()).toEqual({ queued: [], reason: 'no_profile' });
    expect((await analyze(999)).statusCode).toBe(404);
    expect((await analyze('abc')).statusCode).toBe(404);
    app = buildApp(db, { ai: testAi({ env: NO_AI_ENV }) });
    expect((await analyze(job.id)).statusCode).toBe(409);
    expect(await taskTypes()).toEqual([]);
  });
});

describe('moving a job to selecionadas', () => {
  const move = (id: number, column: string) =>
    app.inject({ method: 'PATCH', url: `/api/jobs/${id}`, payload: { column, position: 0 } });

  it('with automatic analysis on, queues the analysis; other columns do not', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const job = await seedJob(db);
    expect((await app.inject({ method: 'PATCH', url: '/settings', payload: { tier2Auto: true } })).statusCode).toBe(200);
    expect((await move(job.id, 'arquivada')).statusCode).toBe(200);
    expect(await taskTypes()).toEqual([]);
    expect((await move(job.id, 'selecionadas')).json().column).toBe('selecionadas');
    expect(await taskTypes()).toEqual(['tier1:queued', 'tier2:queued']);
  });

  it('automatic analysis is off by default: the move queues nothing, an explicit request still does', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const job = await seedJob(db);
    expect((await move(job.id, 'selecionadas')).statusCode).toBe(200);
    expect(await taskTypes()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/ai/status' })).json().tier2Auto).toBe(false);
    expect((await analyze(job.id)).json()).toEqual({ queued: ['tier1', 'tier2'], reason: null });
  });

  it('still moves the card when AI is not configured or there is no profile', async () => {
    const job = await seedJob(db);
    expect((await move(job.id, 'selecionadas')).statusCode).toBe(200);
    app = buildApp(db, { ai: testAi({ env: NO_AI_ENV }) });
    expect((await move(job.id, 'descobertas')).statusCode).toBe(200);
    expect((await move(job.id, 'selecionadas')).json().column).toBe('selecionadas');
    expect(await taskTypes()).toEqual([]);
  });
});

describe('GET /jobs/ai and /jobs/:id/ai', () => {
  it('lists the score, language and translated title of scored jobs, flagging stale ones', async () => {
    const old = await saveProfile(db, 'en', SAMPLE_PROFILE, 'extraido');
    const current = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'traduzido');
    const [a, b, c] = [await seedJob(db), await seedJob(db), await seedJob(db)];
    await db.insert(jobAi).values([
      { jobId: a.id, language: 'en', titlePt: 'Engenheira React', score: 88, reason: 'ótimo', tier1State: 'ok', tier1ProfileVersion: current.version },
      { jobId: b.id, language: 'pt', titlePt: 'Dev', score: 30, reason: 'fraco', tier1State: 'ok', tier1ProfileVersion: old.version },
      { jobId: c.id, tier1State: 'error' },
    ]);
    const list = (await app.inject({ method: 'GET', url: '/jobs/ai' })).json();
    expect(list.sort((x: { jobId: number }, y: { jobId: number }) => x.jobId - y.jobId)).toEqual([
      { jobId: a.id, language: 'en', titlePt: 'Engenheira React', score: 88, stale: false },
      { jobId: b.id, language: 'pt', titlePt: 'Dev', score: 30, stale: true },
    ]);
    // "/jobs/ai" não pode ser confundido com "/jobs/:id".
    expect((await app.inject({ method: 'GET', url: '/api/jobs/ai' })).statusCode).toBe(200);
  });

  it('describes each layer: none, queued, blocked by budget, ok with the analysis, and error', async () => {
    const profile = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const job = await seedJob(db);
    expect(await detail(job.id)).toEqual({
      summary: null, tier1: { state: 'none', task: null }, tier2: { state: 'none', task: null }, descriptionPt: null,
      analysis: null, descriptionAvailable: true,
    });

    await analyze(job.id);
    let d = await detail(job.id);
    expect([d.tier1.state, d.tier2.state]).toEqual(['queued', 'queued']);
    expect(d.tier2.task).toMatchObject({ type: 'tier2', status: 'queued', jobId: job.id });

    await db.update(aiTasks).set({ status: 'blocked_budget' });
    expect((await detail(job.id)).tier2.state).toBe('blocked_budget');

    await db.update(aiTasks).set({ status: 'ok' });
    await db.insert(jobAi).values({
      jobId: job.id, language: 'en', titlePt: 'Dev React', score: 91, reason: 'r', tier1State: 'ok',
      tier1ProfileVersion: profile.version, descriptionPt: 'Descrição traduzida', analysis, descriptionAvailable: false,
      tier2State: 'ok', tier2ProfileVersion: profile.version,
    });
    d = await detail(job.id);
    expect(d).toMatchObject({
      summary: { score: 91, stale: false }, tier1: { state: 'ok' }, tier2: { state: 'ok' },
      descriptionPt: 'Descrição traduzida', analysis, descriptionAvailable: false,
    });

    await db.update(jobAi).set({ tier2State: 'error' });
    await db.update(aiTasks).set({ status: 'error', error: 'limite de taxa' });
    d = await detail(job.id);
    expect(d.tier2).toMatchObject({ state: 'error', task: { error: 'limite de taxa' } });
    expect(d.analysis).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/jobs/999/ai' })).statusCode).toBe(404);
  });
});
