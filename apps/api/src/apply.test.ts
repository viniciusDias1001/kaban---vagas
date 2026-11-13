import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createFakeSite } from '@kv/apply';
import {
  applicationForJob, applyAnswers, applyCommands, applySites, closeDb, createApplication, jobs, saveApplyWorkerState, transitionApplication,
  type Db,
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

describe('the worker says when it cannot run', () => {
  const NO_BROWSER = 'Navegador não encontrado em C:\\Opera GX\\120\\opera.exe; a versão mais nova achada é 121.';

  it('reports what the worker published, and the feature as unavailable with its reason', async () => {
    expect((await app.inject('/apply/status')).json()).toMatchObject({ available: true, unavailableReason: null, worker: null });
    await saveApplyWorkerState(db, { available: true, reason: null }, 1000);
    expect((await app.inject('/apply/status')).json()).toMatchObject({
      available: true, unavailableReason: null, worker: { available: true, reason: null, seenAt: 1000 },
    });
    await saveApplyWorkerState(db, { available: false, reason: NO_BROWSER }, 2000);
    expect((await app.inject('/apply/status')).json()).toMatchObject({
      available: false, unavailableReason: NO_BROWSER, worker: { available: false, reason: NO_BROWSER, seenAt: 2000 },
    });
    // O host não local vence: é o motivo da API que aparece.
    vi.stubEnv('HOST', '0.0.0.0');
    expect((await app.inject('/apply/status')).json()).toMatchObject({ available: false, unavailableReason: expect.stringContaining('local') });
  });

  it('answers 409 apply_unavailable with the worker reason on every route that queues work', async () => {
    await app.inject({ method: 'PATCH', url: '/settings', payload: { applyEnabled: true } });
    const job = await seedJob(db, { source: 'fake', externalId: 'w1', url: 'https://example.com/w1' });
    const other = await seedJob(db, { source: 'fake', externalId: 'w2', url: 'https://example.com/w2' });
    const failed = (await createApplication(db, { jobId: other.id, site: 'fake', trigger: 'auto', mode: 'dry_run' }))!;
    await transitionApplication(db, failed, { status: 'failed' });
    const third = await seedJob(db, { source: 'fake', externalId: 'w3', url: 'https://example.com/w3' });
    const rehearsal = (await createApplication(db, { jobId: third.id, site: 'fake', trigger: 'auto', mode: 'dry_run' }))!;
    await transitionApplication(db, rehearsal, { status: 'dry_run_ready' });
    await saveApplyWorkerState(db, { available: false, reason: NO_BROWSER });
    const calls: [string, string, object?][] = [
      ['POST', `/jobs/${job.id}/application`], ['POST', `/applications/${failed}/retry`], ['POST', `/applications/${rehearsal}/send`],
      ['POST', '/applications/send-rehearsals', { ids: [rehearsal] }], ['POST', '/apply/sessions/greenhouse/open'],
      ['POST', '/apply/sessions/greenhouse/check'], ['DELETE', '/apply/sessions/greenhouse'],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as 'POST', url, payload });
      expect(res.statusCode, url).toBe(409);
      expect(res.json(), url).toEqual({ error: 'apply_unavailable', message: NO_BROWSER });
    }
    expect(await applicationForJob(db, job.id)).toBeNull();
    expect((await applicationForJob(db, other.id))!.status).toBe('failed');
    expect((await applicationForJob(db, third.id))!.status).toBe('dry_run_ready');
    expect(await db.select().from(applyCommands)).toEqual([]);
    // O worker voltou: tudo anda.
    await saveApplyWorkerState(db, { available: true, reason: null });
    expect((await post(`/jobs/${job.id}/application`)).statusCode).toBe(202);
  });
});

describe('every state-changing apply route answers 409 off a local host', () => {
  it('refuses the writes and keeps the reads', async () => {
    const job = await seedJob(db, { source: 'fake', externalId: 'h1', url: 'https://example.com/h1' });
    const id = (await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'dry_run' }))!;
    const saved = (await post('/apply/answers', { question: 'Q?', answer: 'a', kind: 'text', scope: 'always', scopeValue: null, country: null })).json();
    vi.stubEnv('HOST', '0.0.0.0');
    const writes: [string, string, object?][] = [
      ['POST', `/jobs/${job.id}/application`], ['POST', `/applications/${id}/retry`], ['POST', `/applications/${id}/send`],
      ['POST', `/applications/${id}/cancel`], ['POST', '/applications/send-rehearsals', { ids: [id] }],
      ['PUT', `/applications/${id}/answers`, { answers: [] }], ['POST', '/apply/sites/fake/resume'],
      ['POST', '/apply/answers', { question: 'Q2?', answer: 'b', kind: 'text', scope: 'always', scopeValue: null, country: null }],
      ['PUT', `/apply/answers/${saved.id}`, { question: 'Q?', answer: 'c', kind: 'text', scope: 'always', scopeValue: null, country: null }],
      ['DELETE', `/apply/answers/${saved.id}/aliases/x`], ['DELETE', `/apply/answers/${saved.id}`],
      ['POST', '/apply/sessions/greenhouse/open'],
    ];
    for (const [method, url, payload] of writes) {
      const res = await app.inject({ method: method as 'POST', url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json(), `${method} ${url}`).toMatchObject({ error: 'apply_unavailable' });
    }
    expect((await applicationForJob(db, job.id))!.status).toBe('queued');
    expect((await db.select().from(applyAnswers)).map((r) => r.answer)).toEqual(['a']);
    for (const url of ['/apply/status', '/apply/answers', '/applications', `/jobs/${job.id}/application`]) {
      expect((await app.inject(url)).statusCode, url).toBe(200);
    }
  });
});

describe('saving an answer in the profile requeues the applications waiting on a question', () => {
  const input = { question: 'Pretensão salarial?', answer: '20000', kind: 'number', scope: 'always', scopeValue: null, country: null };
  async function waitingOnQuestion() {
    const job = await seedJob(db, { source: 'fake', externalId: `q${Math.random()}`, url: `https://example.com/${Math.random()}`, needsHuman: true, needsHumanReason: 'x' });
    const id = (await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'dry_run' }))!;
    await transitionApplication(db, id, { status: 'needs_human', reason: 'question', set: { pendingQuestions: [] } });
    return job.id;
  }

  it('on POST and on a PUT that changes the answer, never on one that changes nothing', async () => {
    const a = await waitingOnQuestion();
    const created = (await post('/apply/answers', input)).json();
    expect(await applicationForJob(db, a)).toMatchObject({ status: 'queued' });
    expect((await db.select().from(jobs).where(eq(jobs.id, a)))[0]).toMatchObject({ needsHuman: false });
    const b = await waitingOnQuestion();
    const put = (payload: object) => app.inject({ method: 'PUT', url: `/apply/answers/${created.id}`, payload });
    expect((await put(input)).statusCode).toBe(200);
    expect(await applicationForJob(db, b)).toMatchObject({ status: 'needs_human' });
    expect((await put({ ...input, answer: '25000' })).statusCode).toBe(200);
    expect(await applicationForJob(db, b)).toMatchObject({ status: 'queued' });
    // Uma resposta vazia não responde nada.
    const c = await waitingOnQuestion();
    await post('/apply/answers', { ...input, question: 'Outra?', answer: '' });
    expect(await applicationForJob(db, c)).toMatchObject({ status: 'needs_human' });
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

  it('applies the number rule to a number row, on POST and PUT, and stores the normalised text', async () => {
    const bad = ['20.000', '1,234', '1.234,56', 'doze', '1.5.5', '1,234.5'];
    for (const answer of bad) {
      const res = await post('/apply/answers', { ...input, answer });
      expect(res.statusCode, answer).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation', message: expect.stringContaining('sem separador de milhar') });
    }
    expect((await app.inject('/apply/answers')).json()).toHaveLength(8);
    const created = await post('/apply/answers', { ...input, answer: '1234,56' });
    expect(created.json()).toMatchObject({ answer: '1234.56' });
    const put = (answer: string) => app.inject({ method: 'PUT', url: `/apply/answers/${created.json().id}`, payload: { ...input, answer } });
    expect((await put('20.000')).statusCode).toBe(400);
    expect((await put('-5,5')).json()).toMatchObject({ answer: '-5.5' });
    expect((await put('')).json()).toMatchObject({ answer: '' });
    // Só a linha de número é conferida.
    expect((await post('/apply/answers', { ...input, kind: 'text', answer: '20.000' })).statusCode).toBe(200);
  });

  it('deletes an answer and removes one variation', async () => {
    const saved = (await post('/apply/answers', input)).json();
    await db.update(applyAnswers).set({ aliases: [{ normalized: 'quanto quer', options: [], value: '1' }, { normalized: 'outra', options: [], value: '2' }] })
      .where(eq(applyAnswers.id, saved.id));
    expect((await app.inject({ method: 'DELETE', url: `/apply/answers/${saved.id}/aliases/quanto%20quer` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/apply/answers/9999/aliases/x' })).statusCode).toBe(404);
    expect((await db.select().from(applyAnswers).where(eq(applyAnswers.id, saved.id)))[0].aliases).toEqual([{ normalized: 'outra', options: [], value: '2' }]);
    expect((await app.inject({ method: 'DELETE', url: `/apply/answers/${saved.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/apply/answers/${saved.id}` })).statusCode).toBe(404);
  });
});
