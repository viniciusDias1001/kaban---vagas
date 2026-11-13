import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createFakeSite, exactBankMatch } from '@kv/apply';
import {
  applicationForJob, applications, applyAnswers, closeDb, createApplication, jobs, listApplyAnswers, transitionApplication, type Db,
} from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import type { AnswerValue, PendingQuestion, Question } from '@kv/shared';
import { buildApp } from './app';
import { seedJob, testAi } from './ai-testing';

let db: Db;
let app: ReturnType<typeof buildApp>;
let dataDir: string;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  dataDir = await mkdtemp(join(tmpdir(), 'kv-apply-api-'));
  app = buildApp(db, { ai: testAi({ sites: [createFakeSite()], dataDir }) });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});
afterAll(() => closeDb(db));

const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, payload });
const put = (url: string, payload: object) => app.inject({ method: 'PUT', url, payload });
const enable = (extra: object = {}) => app.inject({ method: 'PATCH', url: '/settings', payload: { applyEnabled: true, ...extra } });
const jobRow = async (id: number) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];

let seq = 0;
const fakeJob = (over: Partial<typeof jobs.$inferInsert> = {}) => {
  seq += 1;
  return seedJob(db, { source: 'fake', externalId: `f${seq}`, url: `https://example.com/fake/${seq}`, ...over });
};

const question = (id: string, over: Partial<Question> = {}): Question => ({
  id, label: `Pergunta ${id}`, help: '', kind: 'text', options: [], required: true, maxLength: null, ...over,
});
const unanswered = (q: Question): PendingQuestion => ({ question: q, category: 'unknown', kind: 'unanswered', proposal: null });

/** Candidatura parada em `needs_human` com as perguntas dadas (como o worker deixa). */
async function seedPending(pending: PendingQuestion[], reason: 'question' | 'captcha' = 'question', jobOver: Partial<typeof jobs.$inferInsert> = {}) {
  const job = await fakeJob({ needsHuman: true, needsHumanReason: 'Falta uma resposta.', ...jobOver });
  const id = (await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'dry_run' }))!;
  await transitionApplication(db, id, { status: 'needs_human', reason, set: { pendingQuestions: pending } });
  return { job, id };
}
const item = (questionId: string, value: unknown, over: object = {}) => ({ questionId, value, scope: 'always', confirmMatch: false, ...over });

describe('POST /jobs/:id/application', () => {
  it('creates a manual application for a supported job only once', async () => {
    await enable();
    const job = await fakeJob();
    const remotive = await seedJob(db, { source: 'remotive' });
    const first = await post(`/jobs/${job.id}/application`);
    expect(first.statusCode).toBe(202);
    expect(await applicationForJob(db, job.id)).toMatchObject({ id: first.json().id, trigger: 'manual', mode: 'dry_run', status: 'queued', site: 'fake' });
    const again = await post(`/jobs/${job.id}/application`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'already_exists' });
    expect((await post(`/jobs/${remotive.id}/application`)).json()).toMatchObject({ error: 'unsupported_site' });
    expect((await post('/jobs/99999/application')).statusCode).toBe(404);
  });

  it('refuses a manual application to a blocked company', async () => {
    await enable({ applyBlockedCompanies: ['Acme'] });
    const job = await fakeJob();
    const res = await post(`/jobs/${job.id}/application`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'blocked' });
    expect(await applicationForJob(db, job.id)).toBeNull();
  });

  it('refuses while the feature is off or unavailable', async () => {
    const job = await fakeJob();
    expect((await post(`/jobs/${job.id}/application`)).json()).toMatchObject({ error: 'apply_disabled' });
    await enable();
    vi.stubEnv('HOST', '0.0.0.0');
    const res = await post(`/jobs/${job.id}/application`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'apply_unavailable' });
  });
});

describe('reading applications', () => {
  it('never returns the PDF bytes in JSON; null for a job without an application, 404 only for a missing job', async () => {
    const job = await fakeJob();
    // Toda vaga aberta no painel pergunta pela candidatura: "não tem" é resposta normal (200 null), não um 404 que o
    // navegador registra como erro no console.
    const none = await app.inject(`/jobs/${job.id}/application`);
    expect(none.statusCode).toBe(200);
    expect(none.json()).toBeNull();
    expect((await app.inject('/jobs/99999/application')).statusCode).toBe(404);
    await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'dry_run' });
    await db.update(applications).set({ resumePdf: Buffer.from('%PDF-1.4 segredo'), approvedAnswers: [] });
    const body = (await app.inject(`/jobs/${job.id}/application`)).body;
    expect(JSON.parse(body)).toMatchObject({ hasResume: true, status: 'queued', events: [{ status: 'queued' }] });
    expect(body).not.toContain('resumePdf');
    expect(body).not.toContain('approvedAnswers');
    expect(body).not.toContain('segredo');
  });

  it('lists with filters and rejects unknown ones', async () => {
    const a = await fakeJob();
    const b = await fakeJob();
    await createApplication(db, { jobId: a.id, site: 'fake', trigger: 'auto', mode: 'dry_run' });
    const idB = (await createApplication(db, { jobId: b.id, site: 'fake', trigger: 'auto', mode: 'dry_run' }))!;
    await transitionApplication(db, idB, { status: 'failed' });
    expect((await app.inject('/applications')).json()).toHaveLength(2);
    expect((await app.inject('/applications?status=failed&site=fake')).json()).toMatchObject([{ id: idB, jobTitle: 'Dev React' }]);
    expect((await app.inject('/applications?status=nope')).statusCode).toBe(400);
  });

  it('serves the sent PDF and the photos, and nothing outside the data folder', async () => {
    const job = await fakeJob();
    const id = (await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'dry_run' }))!;
    await mkdir(join(dataDir, 'shots', String(id)), { recursive: true });
    await writeFile(join(dataDir, 'shots', String(id), 'filled.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(join(dataDir, '..', 'segredo-do-teste.jpg'), Buffer.from('segredo'));
    await db.update(applications).set({
      resumePdf: Buffer.from('%PDF-1.4'), resumeFileName: 'Meu Curriculo.pdf',
      shots: { filled: `shots/${id}/filled.jpg`, blocked: `shots/${id}/blocked.jpg` },
    });
    const pdf = await app.inject(`/applications/${id}/resume.pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['cache-control']).toBe('no-store');
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="Meu_Curriculo.pdf"');
    const shot = await app.inject(`/applications/${id}/shots/filled`);
    expect(shot.headers['content-type']).toBe('image/jpeg');
    expect(shot.headers['cache-control']).toBe('no-store');
    expect((await app.inject(`/applications/${id}/shots/blocked`)).statusCode).toBe(404); // gravada, arquivo não existe
    expect((await app.inject(`/applications/${id}/shots/confirmation`)).statusCode).toBe(404); // nunca gravada
    expect((await app.inject(`/applications/${id}/shots/passwd`)).statusCode).toBe(404); // tipo desconhecido
    await db.update(applications).set({ shots: { filled: '../segredo-do-teste.jpg' } });
    expect((await app.inject(`/applications/${id}/shots/filled`)).statusCode).toBe(404);
    await db.update(applications).set({ resumePdf: null });
    expect((await app.inject(`/applications/${id}/resume.pdf`)).statusCode).toBe(404);
    await rm(join(dataDir, '..', 'segredo-do-teste.jpg'), { force: true });
  });
});

describe('PUT /applications/:id/answers', () => {
  it('saves the owner answers to the bank and requeues the application', async () => {
    const { id, job } = await seedPending([unanswered(question('q5', { label: 'Pretensão salarial', kind: 'number' }))]);
    const res = await put(`/applications/${id}/answers`, { answers: [item('q5', '20000')] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', pendingQuestions: [] });
    const bank = await listApplyAnswers(db);
    expect(bank).toMatchObject([{ question: 'Pretensão salarial', answer: '20000', kind: 'number', scope: 'always', country: 'BR' }]);
    expect(await jobRow(job.id)).toMatchObject({ needsHuman: false, needsHumanReason: null });
  });

  it('uses the company or the job as the scope value and no country for jobs abroad', async () => {
    const { id, job } = await seedPending(
      [unanswered(question('a')), unanswered(question('b'))], 'question', { country: 'INT', company: 'Globex' },
    );
    await put(`/applications/${id}/answers`, { answers: [item('a', 'x', { scope: 'company' }), item('b', 'y', { scope: 'job' })] });
    expect((await listApplyAnswers(db)).map((r) => [r.scope, r.scopeValue, r.country])).toEqual([
      ['company', 'Globex', null], ['job', String(job.id), null],
    ]);
  });

  it('updates the saved row of the same question instead of duplicating it', async () => {
    await db.insert(applyAnswers).values({ question: 'Pergunta a', normalized: 'pergunta a', kind: 'text', country: 'BR', createdAt: 1, updatedAt: 1 });
    const { id } = await seedPending([unanswered(question('a'))]);
    await put(`/applications/${id}/answers`, { answers: [item('a', 'novo')] });
    expect(await listApplyAnswers(db)).toMatchObject([{ answer: 'novo' }]);
  });

  it('requeues the other applications that were waiting on a question', async () => {
    const { id } = await seedPending([unanswered(question('q5'))]);
    const other = await seedPending([unanswered(question('q9'))]);
    const captcha = await seedPending([], 'captcha');
    await put(`/applications/${id}/answers`, { answers: [item('q5', 'x')] });
    expect(await applicationForJob(db, other.job.id)).toMatchObject({ status: 'queued', mode: 'dry_run' });
    expect(await jobRow(other.job.id)).toMatchObject({ needsHuman: false });
    expect((await applicationForJob(db, captcha.job.id))!.status).toBe('needs_human');
    expect(await jobRow(captcha.job.id)).toMatchObject({ needsHuman: true });
  });

  it('keeps the application waiting while a required question is left out', async () => {
    const { id, job } = await seedPending([unanswered(question('a')), unanswered(question('b')), unanswered(question('c', { required: false }))]);
    const res = await put(`/applications/${id}/answers`, { answers: [item('a', 'x')] });
    expect(res.json()).toMatchObject({ status: 'needs_human', reason: 'question' });
    expect(res.json().pendingQuestions.map((p: PendingQuestion) => p.question.id)).toEqual(['b', 'c']);
    expect(await jobRow(job.id)).toMatchObject({ needsHuman: true });
    const done = await put(`/applications/${id}/answers`, { answers: [item('b', 'y')] });
    expect(done.json()).toMatchObject({ status: 'queued', pendingQuestions: [] }); // a opcional que ficou é descartada
  });

  it('records a confirmed match as a variation, so a second run answers by itself', async () => {
    const saved = (await db.insert(applyAnswers).values({
      question: 'Precisa de visto?', normalized: 'precisa de visto', kind: 'choice', answer: 'No', createdAt: 1, updatedAt: 1,
    }).returning())[0];
    const q = question('v', { label: 'Do you require sponsorship?', kind: 'select', options: ['Yes', 'No'] });
    const match: PendingQuestion = {
      question: q, category: 'personal', kind: 'confirm_match',
      proposal: { bankAnswerId: saved.id, bankQuestion: saved.question, bankAnswer: 'No', value: 'No', source: 'bank', basis: [] },
    };
    const { id, job } = await seedPending([match]);
    expect(exactBankMatch(q, await listApplyAnswers(db), { company: 'Acme', jobId: job.id, country: 'BR' })).toBeNull();
    const res = await put(`/applications/${id}/answers`, { answers: [item('v', null, { confirmMatch: true })] });
    expect(res.json()).toMatchObject({ status: 'queued' });
    const bank = await listApplyAnswers(db);
    expect(bank).toHaveLength(1);
    expect(bank[0].aliases).toEqual([{ normalized: 'do you require sponsorship', options: ['Yes', 'No'], value: 'No' }]);
    expect(exactBankMatch(q, bank, { company: 'Acme', jobId: job.id, country: 'BR' })?.value).toBe('No');
  });

  it('accepts a proposal: the profile fact for always, the written text for the job only', async () => {
    const proposal = (value: string, source: 'profile' | 'written') => ({
      bankAnswerId: null, bankQuestion: null, bankAnswer: null, value, source, basis: [],
    });
    const fact = question('f', { label: 'Anos de React?' });
    const text = question('w', { label: 'Por que nós?', kind: 'longtext' });
    const { id, job } = await seedPending([
      { question: fact, category: 'profile_fact', kind: 'confirm_proposal', proposal: proposal('5', 'profile') },
      { question: text, category: 'open', kind: 'confirm_proposal', proposal: proposal('Gosto do produto.', 'written') },
    ]);
    const res = await put(`/applications/${id}/answers`, {
      answers: [item('f', null, { confirmMatch: true, scope: 'job' }), item('w', null, { confirmMatch: true, scope: 'always' })],
    });
    expect(res.json()).toMatchObject({ status: 'queued' });
    const bank = await listApplyAnswers(db);
    expect(bank.map((r) => [r.question, r.answer, r.scope, r.scopeValue])).toEqual([
      ['Anos de React?', '5', 'always', null], ['Por que nós?', 'Gosto do produto.', 'job', String(job.id)],
    ]);
    const ctx = { company: 'Acme', jobId: job.id, country: 'BR' };
    expect(exactBankMatch(fact, bank, ctx)?.value).toBe('5');
    expect(exactBankMatch(text, bank, ctx)?.value).toBe('Gosto do produto.');
    expect(exactBankMatch(text, bank, { ...ctx, jobId: job.id + 1 })).toBeNull();
  });

  it('refuses answers that do not fit the question, saving and changing nothing', async () => {
    const pending = [
      unanswered(question('sel', { kind: 'select', options: ['Sim', 'Não'] })),
      unanswered(question('multi', { kind: 'multiselect', options: ['A', 'B'] })),
      unanswered(question('num', { kind: 'number' })),
      unanswered(question('bool', { kind: 'boolean' })),
      unanswered(question('short', { maxLength: 5 })),
    ];
    const { id } = await seedPending(pending);
    const bad = async (items: object[]) => {
      const res = await put(`/applications/${id}/answers`, { answers: items });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation' });
    };
    await bad([item('nope', 'x')]);
    await bad([item('sel', 'Talvez')]);
    await bad([item('multi', [])]);
    await bad([item('multi', ['A', 'C'])]);
    await bad([item('multi', 'A')]);
    await bad([item('num', 'doze')]);
    await bad([item('bool', 'sim')]);
    await bad([item('short', 'passa do limite')]);
    await bad([item('num', '20.000')]);
    await bad([item('num', '1,234')]);
    await bad([item('num', '1.234,56')]);
    await bad([item('num', '1.5.5')]);
    await bad([item('short', null)]);
    await bad([item('short', '   ')]);
    await bad([item('short', 'ok', { confirmMatch: true })]); // nada para aceitar numa pergunta sem proposta
    await bad([item('short', 'a'), item('short', 'b')]);
    await bad([item('sel', 'Sim'), item('num', 'doze')]); // o item bom não é gravado
    expect(await listApplyAnswers(db)).toEqual([]);
    expect((await applicationForJob(db, (await db.select().from(applications))[0].jobId))).toMatchObject({ status: 'needs_human' });
    // Valores certos: opção com a grafia do formulário, lista, número, sim/não.
    const ok = await put(`/applications/${id}/answers`, {
      answers: [item('sel', ' sim '), item('multi', ['b', 'A']), item('num', '1,5'), item('bool', true), item('short', '  ok  ')],
    });
    expect(ok.json()).toMatchObject({ status: 'queued' });
    expect((await listApplyAnswers(db)).map((r) => r.answer)).toEqual(['Sim', 'B\nA', '1.5', 'Sim', 'ok']);
  });

  it('answers 409 not_pending outside needs_human with a question, and 404', async () => {
    const waiting = await seedPending([], 'captcha');
    const res = await put(`/applications/${waiting.id}/answers`, { answers: [] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_pending' });
    expect((await put('/applications/9999/answers', { answers: [] })).statusCode).toBe(404);
    expect((await put(`/applications/${waiting.id}/answers`, { answers: [], x: 1 })).statusCode).toBe(400);
  });
});

describe('answers are read back from the bank in the own type of the question', () => {
  const ctxOf = (jobId: number) => ({ company: 'Acme Fictícia', jobId, country: 'BR' });
  const cases: { name: string; q: Question; value: unknown; expected: unknown }[] = [
    { name: 'text', q: question('t'), value: 'olá', expected: 'olá' },
    { name: 'longtext', q: question('l', { kind: 'longtext' }), value: 'um texto longo', expected: 'um texto longo' },
    { name: 'number', q: question('n', { kind: 'number' }), value: '20000,5', expected: '20000.5' },
    { name: 'boolean true', q: question('bt', { kind: 'boolean' }), value: true, expected: true },
    { name: 'boolean false', q: question('bf', { kind: 'boolean' }), value: false, expected: false },
    { name: 'boolean with options', q: question('bo', { kind: 'boolean', options: ['Yes', 'No'] }), value: true, expected: 'Yes' },
    { name: 'select', q: question('s', { kind: 'select', options: ['Jr', 'Sr'] }), value: 'sr', expected: 'Sr' },
    {
      name: 'multiselect', q: question('m', { kind: 'multiselect', options: ['Remoto', 'Híbrido', 'Presencial'] }),
      value: ['presencial', 'Remoto'], expected: ['Presencial', 'Remoto'],
    },
  ];
  for (const c of cases) {
    it(`${c.name}`, async () => {
      const { id, job } = await seedPending([unanswered(c.q)]);
      expect((await put(`/applications/${id}/answers`, { answers: [item(c.q.id, c.value)] })).statusCode).toBe(200);
      const hit = exactBankMatch(c.q, await listApplyAnswers(db), ctxOf(job.id));
      expect(hit?.value).toEqual(c.expected);
      expect(typeof hit?.value).toBe(Array.isArray(c.expected) ? 'object' : typeof c.expected);
    });
  }

  it('a confirmed match on a multiselect and on a boolean without options', async () => {
    const saved = async (question_: string, answer: string, kind: 'choice' | 'boolean') =>
      (await db.insert(applyAnswers).values({ question: question_, normalized: question_.toLowerCase().replace(/\W+/g, ' ').trim(), kind, answer, createdAt: 1, updatedAt: 1 }).returning())[0];
    const models = await saved('Modelos de trabalho', 'Remoto\nHíbrido', 'choice');
    const auth = await saved('Autorizado a trabalhar', 'Sim', 'boolean');
    const multi = question('m', { label: 'Work models', kind: 'multiselect', options: ['Remote', 'Hybrid', 'Onsite'] });
    const bool = question('b', { label: 'Authorized to work', kind: 'boolean' });
    const pending = (q: Question, row: typeof models, value: AnswerValue): PendingQuestion => ({
      question: q, category: 'personal', kind: 'confirm_match',
      proposal: { bankAnswerId: row.id, bankQuestion: row.question, bankAnswer: row.answer, value, source: 'bank', basis: [] },
    });
    const { id, job } = await seedPending([pending(multi, models, ['Remote', 'Hybrid']), pending(bool, auth, true)]);
    const res = await put(`/applications/${id}/answers`, { answers: [item('m', null, { confirmMatch: true }), item('b', null, { confirmMatch: true })] });
    expect(res.json()).toMatchObject({ status: 'queued' });
    const bank = await listApplyAnswers(db);
    expect(exactBankMatch(multi, bank, ctxOf(job.id))?.value).toEqual(['Remote', 'Hybrid']);
    expect(exactBankMatch(bool, bank, ctxOf(job.id))?.value).toBe(true);
  });

  it('an accepted saved-answer match on a question without options keeps the proposal as it is', async () => {
    const saved = (await db.insert(applyAnswers).values({
      question: 'Pretensão', normalized: 'pretensao', kind: 'text', answer: 'a combinar, depende da vaga', createdAt: 1, updatedAt: 1,
    }).returning())[0];
    const match = (q: Question, value: AnswerValue): PendingQuestion => ({
      question: q, category: 'personal', kind: 'confirm_match',
      proposal: { bankAnswerId: saved.id, bankQuestion: saved.question, bankAnswer: saved.answer, value, source: 'bank', basis: [] },
    });
    const num = question('n', { label: 'Salary expectation', kind: 'number' });
    const short = question('s', { label: 'Expected pay', maxLength: 5 });
    const { id } = await seedPending([match(num, 'a combinar'), match(short, 'a combinar, depende')]);
    const res = await put(`/applications/${id}/answers`, {
      answers: [item('n', null, { confirmMatch: true }), item('s', null, { confirmMatch: true })],
    });
    expect(res.statusCode).toBe(200);
    expect((await listApplyAnswers(db))[0].aliases.map((a) => a.value)).toEqual(['a combinar', 'a combinar, depende']);
  });

  it('an accepted saved-answer match still has to be one of the options', async () => {
    const saved = (await db.insert(applyAnswers).values({
      question: 'Visto', normalized: 'visto', kind: 'choice', answer: 'Talvez', createdAt: 1, updatedAt: 1,
    }).returning())[0];
    const q = question('v', { label: 'Sponsorship?', kind: 'select', options: ['Yes', 'No'] });
    const { id } = await seedPending([{
      question: q, category: 'personal', kind: 'confirm_match',
      proposal: { bankAnswerId: saved.id, bankQuestion: saved.question, bankAnswer: 'Talvez', value: 'Talvez', source: 'bank', basis: [] },
    }]);
    expect((await put(`/applications/${id}/answers`, { answers: [item('v', null, { confirmMatch: true })] })).statusCode).toBe(400);
  });

  it('an accepted proposal keeps the full checks', async () => {
    const q = question('n', { label: 'Anos', kind: 'number' });
    const { id } = await seedPending([{
      question: q, category: 'profile_fact', kind: 'confirm_proposal',
      proposal: { bankAnswerId: null, bankQuestion: null, bankAnswer: null, value: 'muitos', source: 'profile', basis: [] },
    }]);
    expect((await put(`/applications/${id}/answers`, { answers: [item('n', null, { confirmMatch: true })] })).statusCode).toBe(400);
  });

  it('an accepted proposal whose value is a boolean', async () => {
    const q = question('p', { label: 'Aceita mudança?', kind: 'boolean' });
    const { id, job } = await seedPending([{
      question: q, category: 'profile_fact', kind: 'confirm_proposal',
      proposal: { bankAnswerId: null, bankQuestion: null, bankAnswer: null, value: false, source: 'profile', basis: [] },
    }]);
    await put(`/applications/${id}/answers`, { answers: [item('p', null, { confirmMatch: true })] });
    expect(exactBankMatch(q, await listApplyAnswers(db), ctxOf(job.id))?.value).toBe(false);
  });

  it('checks maxLength on the trimmed text', async () => {
    const { id } = await seedPending([unanswered(question('short', { maxLength: 5 }))]);
    expect((await put(`/applications/${id}/answers`, { answers: [item('short', '  abcde  ')] })).statusCode).toBe(200);
  });
});

describe('send, retry and cancel', () => {
  const answers = [{
    questionId: 'q', value: '1', source: 'bank' as const, category: 'profile_fact' as const, basis: [], bankAnswerId: null,
    label: 'Q', help: '', kind: 'text' as const, options: [], required: true,
  }];
  async function seedApp(status: Parameters<typeof transitionApplication>[2]['status'], reason?: 'confirm_submission', set: object = {}) {
    const job = await fakeJob();
    const id = (await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'dry_run' }))!;
    if (status !== 'queued') await transitionApplication(db, id, { status, reason, set });
    return { job, id };
  }

  it('sends a rehearsal for real, approving its answers, and never requeues a sent application', async () => {
    const rehearsal = await seedApp('dry_run_ready', undefined, { answers });
    const sent = await seedApp('submitted');
    expect((await post(`/applications/${rehearsal.id}/send`)).statusCode).toBe(202);
    expect(await applicationForJob(db, rehearsal.job.id)).toMatchObject({ status: 'queued', mode: 'real', answers, approvedAnswers: answers });
    expect((await post(`/applications/${rehearsal.id}/send`)).json()).toMatchObject({ error: 'not_rehearsal' });
    expect((await post(`/applications/${sent.id}/retry`)).json()).toMatchObject({ error: 'sent' });
    expect((await post(`/applications/${sent.id}/send`)).statusCode).toBe(409);
    expect((await post('/applications/9999/send')).statusCode).toBe(404);
  });

  it('sends every rehearsal at once', async () => {
    const one = await seedApp('dry_run_ready', undefined, { answers });
    const two = await seedApp('dry_run_ready', undefined, { answers });
    const failed = await seedApp('failed');
    const res = await post('/applications/send-rehearsals');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: 2 });
    expect((await applicationForJob(db, one.job.id))!.approvedAnswers).toEqual(answers);
    expect(await applicationForJob(db, two.job.id)).toMatchObject({ status: 'queued', mode: 'real' });
    expect(await applicationForJob(db, failed.job.id)).toMatchObject({ status: 'failed', approvedAnswers: [] });
  });

  it('clears finished_at when a finished application is retried', async () => {
    const failed = await seedApp('failed');
    expect((await applicationForJob(db, failed.job.id))!.finishedAt).not.toBeNull();
    await post(`/applications/${failed.id}/retry`);
    expect((await applicationForJob(db, failed.job.id))!.finishedAt).toBeNull();
  });

  it('retries stopped applications without approving anything, and refuses the others', async () => {
    for (const status of ['needs_human', 'failed', 'skipped', 'cancelled'] as const) {
      const a = await seedApp(status);
      expect((await post(`/applications/${a.id}/retry`)).statusCode).toBe(202);
      expect(await applicationForJob(db, a.job.id)).toMatchObject({ status: 'queued', approvedAnswers: [] });
    }
    expect((await post(`/applications/${(await seedApp('filling')).id}/retry`)).json()).toMatchObject({ error: 'in_progress' });
    const unconfirmed = await seedApp('needs_human', 'confirm_submission');
    expect((await post(`/applications/${unconfirmed.id}/retry`)).json()).toMatchObject({ error: 'confirm_submission' });
    expect((await applicationForJob(db, unconfirmed.job.id))!.status).toBe('needs_human');
    expect((await post('/applications/9999/retry')).statusCode).toBe(404);
  });

  it('cancels a waiting application, flags a running one and refuses a finished one', async () => {
    const waiting = await seedApp('needs_human');
    await db.update(jobs).set({ needsHuman: true, needsHumanReason: 'x' }).where(eq(jobs.id, waiting.job.id));
    const running = await seedApp('filling');
    const done = await seedApp('submitted');
    expect((await post(`/applications/${waiting.id}/cancel`)).statusCode).toBe(204);
    expect((await applicationForJob(db, waiting.job.id))!.status).toBe('cancelled');
    expect(await jobRow(waiting.job.id)).toMatchObject({ needsHuman: false });
    expect((await post(`/applications/${running.id}/cancel`)).statusCode).toBe(204);
    expect(await applicationForJob(db, running.job.id)).toMatchObject({ status: 'filling', cancelRequested: true });
    expect((await post(`/applications/${done.id}/cancel`)).statusCode).toBe(409);
    expect((await post('/applications/9999/cancel')).statusCode).toBe(404);
  });
});
