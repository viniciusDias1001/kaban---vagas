import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createFakeSite } from '@kv/apply';
import {
  applyAnswers, applyCommands, applySites, closeDb, createApplication, transitionApplication, type Db,
} from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { buildApp } from './app';
import { seedJob, testAi } from './ai-testing';

let db: Db;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi({ sites: [createFakeSite(), { ...createFakeSite(), id: 'greenhouse', needsLogin: true, loginUrl: 'https://x.example' }] }) });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => closeDb(db));

const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, payload });

describe('GET /apply/status', () => {
  it('reports the feature as unavailable off a local host', async () => {
    vi.stubEnv('HOST', '0.0.0.0');
    const res = await app.inject('/apply/status');
    expect(res.json()).toMatchObject({ available: false, unavailableReason: expect.stringContaining('local'), enabled: false });
  });

  it('reports per-site counts, caps, modes, pauses and the queue', async () => {
    const job = await seedJob(db, { source: 'fake', externalId: 'a', url: 'https://example.com/a' });
    const id = (await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'dry_run' }))!;
    const body = (await app.inject('/apply/status')).json();
    expect(body).toMatchObject({ available: true, queued: 1, needsHuman: 0, running: 0, waiting: null, totalToday: 0, totalCap: 30 });
    expect(body.sites.find((s: { site: string }) => s.site === 'fake')).toMatchObject({
      mode: 'dry_run', formsToday: 0, formsCap: 15, paused: false, needsLogin: false, viewsToday: null,
    });
    await transitionApplication(db, id, { status: 'waiting_human', set: { waitingGate: 'captcha' } });
    expect((await app.inject('/apply/status')).json()).toMatchObject({
      queued: 0, running: 1, waiting: { applicationId: id, jobId: job.id, gate: 'captcha' },
    });
  });
});

describe('sessions', () => {
  it('queues a login command once and refuses sites without login', async () => {
    expect((await post('/apply/sessions/greenhouse/open')).statusCode).toBe(202);
    expect((await post('/apply/sessions/greenhouse/open')).json()).toEqual({ queued: true });
    expect(await db.select().from(applyCommands)).toHaveLength(1);
    expect((await post('/apply/sessions/greenhouse/check')).statusCode).toBe(202);
    expect((await app.inject({ method: 'DELETE', url: '/apply/sessions/greenhouse' })).statusCode).toBe(202);
    expect((await db.select().from(applyCommands)).map((c) => c.kind).sort()).toEqual(['check_session', 'logout', 'open_login']);
    const noLogin = await post('/apply/sessions/fake/open');
    expect(noLogin.statusCode).toBe(400);
    expect(noLogin.json()).toMatchObject({ error: 'no_login' });
    expect((await post('/apply/sessions/nowhere/open')).statusCode).toBe(404);
  });

  it('answers 409 apply_unavailable off a local host', async () => {
    vi.stubEnv('HOST', '0.0.0.0');
    const res = await post('/apply/sessions/greenhouse/open');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'apply_unavailable' });
  });
});

describe('POST /apply/sites/:site/resume', () => {
  it('lifts a pause and zeroes the streaks', async () => {
    await db.insert(applySites).values({
      site: 'fake', paused: true, pauseReason: 'brake', pausedAt: 1, consecutiveFailures: 3, consecutiveRejections: 2, humanTimeouts: 2,
    });
    expect((await app.inject('/apply/status')).json().sites.find((s: { site: string }) => s.site === 'fake')).toMatchObject({ paused: true });
    expect((await post('/apply/sites/fake/resume')).statusCode).toBe(204);
    expect((await db.select().from(applySites).where(eq(applySites.site, 'fake')))[0]).toMatchObject({
      paused: false, pauseReason: null, consecutiveFailures: 0, consecutiveRejections: 0, humanTimeouts: 0,
    });
    expect((await post('/apply/sites/nowhere/resume')).statusCode).toBe(404);
  });
});

describe('the answer bank', () => {
  const input = { question: 'Pretensão salarial?', answer: '20000', kind: 'number', scope: 'always', scopeValue: null, country: null };

  it('lists the seeded questions and saves an answer', async () => {
    const first = (await app.inject('/apply/answers')).json();
    expect(first).toHaveLength(8);
    expect((await app.inject('/apply/answers')).json()).toHaveLength(8);
    const put = await app.inject({ method: 'PUT', url: `/apply/answers/${first[0].id}`, payload: { ...input, question: first[0].question } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ id: first[0].id, answer: '20000' });
    expect((await app.inject('/apply/answers')).json()[0]).toMatchObject({ answer: '20000' });
    const created = await post('/apply/answers', input);
    expect(created.json()).toMatchObject({ question: 'Pretensão salarial?', usedCount: 0 });
    expect((await app.inject('/apply/answers')).json()).toHaveLength(9);
  });

  it('validates the body, the scope value and the id', async () => {
    expect((await post('/apply/answers', { ...input, extra: 1 })).statusCode).toBe(400);
    expect((await post('/apply/answers', { ...input, answer: 'a'.repeat(2001) })).statusCode).toBe(400);
    expect((await post('/apply/answers', { ...input, scope: 'company', scopeValue: ' ' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/apply/answers/9999', payload: input })).statusCode).toBe(404);
  });

  it('deletes an answer and removes one variation', async () => {
    const saved = (await post('/apply/answers', input)).json();
    await db.update(applyAnswers).set({ aliases: [{ normalized: 'quanto quer', options: [], value: '1' }, { normalized: 'outra', options: [], value: '2' }] })
      .where(eq(applyAnswers.id, saved.id));
    expect((await app.inject({ method: 'DELETE', url: `/apply/answers/${saved.id}/aliases/quanto%20quer` })).statusCode).toBe(204);
    expect((await db.select().from(applyAnswers).where(eq(applyAnswers.id, saved.id)))[0].aliases).toEqual([{ normalized: 'outra', options: [], value: '2' }]);
    expect((await app.inject({ method: 'DELETE', url: `/apply/answers/${saved.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/apply/answers/${saved.id}` })).statusCode).toBe(404);
  });
});
