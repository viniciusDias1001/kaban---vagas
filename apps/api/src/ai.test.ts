import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SAMPLE_PROFILE, SAMPLE_RESUME_TEXT } from '@kv/ai/testing';
import { aiTasks, closeDb, recordUsage, resumes, saveProfile, searchProfiles, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { makeDocx, makeImageOnlyPdf, makePlainZip, makeTextPdf } from '@kv/resume/testing';
import { LIMITS } from '@kv/shared';
import { NO_AI_ENV, testAi, upload } from './ai-testing';
import { buildApp } from './app';

let db: Db;
let app: ReturnType<typeof buildApp>;
let pdf: Buffer;

beforeAll(async () => {
  db = await createTestDb();
  pdf = await makeTextPdf(SAMPLE_RESUME_TEXT);
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi() });
});
afterAll(() => closeDb(db));

const post = (url: string, body: ReturnType<typeof upload>) => app.inject({ method: 'POST', url, ...body });
const tasks = () => db.select().from(aiTasks);

describe('GET /ai/status and /ai/usage', () => {
  it('reports provider, models and the budget of the day', async () => {
    const now = Date.UTC(2026, 10, 11, 15, 0, 0);
    const usage = { provider: 'fake', model: 'fake-fast', inputTokens: 1, outputTokens: 1 };
    await recordUsage(db, { ...usage, layer: 'tier1', costUsd: 0.4, createdAt: now - 3_600_000 });
    await recordUsage(db, { ...usage, layer: 'tier2', costUsd: 0.7, createdAt: now - 60_000 });
    // 02:00 UTC do dia 11 ainda é dia 10 em São Paulo: não entra no gasto de hoje.
    await recordUsage(db, { ...usage, layer: 'tier3', costUsd: 5, createdAt: Date.UTC(2026, 10, 11, 2, 0, 0) });

    const status = (await app.inject({ method: 'GET', url: '/ai/status' })).json();
    expect(status).toEqual({
      configured: true, problem: null, provider: 'fake', models: { fast: 'fake-fast', strong: 'fake-strong' }, tier2Auto: true,
      budget: { dailyUsd: 1, spentTodayUsd: expect.closeTo(1.1), exceeded: true, timeZone: 'America/Sao_Paulo' },
      scoringPause: null,
    });
    const usageDto = (await app.inject({ method: 'GET', url: '/api/ai/usage' })).json();
    expect(usageDto.today).toEqual({ profile: 0, tier1: 0.4, tier2: 0.7, tier3: 0, test: 0 });
    expect(usageDto.last30Days.tier3).toBe(5);
  });

  it('says why AI is not configured, and the core routes keep working', async () => {
    app = buildApp(db, { ai: testAi({ env: NO_AI_ENV }) });
    expect((await app.inject({ method: 'GET', url: '/ai/status' })).json()).toMatchObject({
      configured: false, problem: 'Nenhum provedor de IA escolhido. Escolha um em Configurações.', provider: null, models: null,
      budget: { dailyUsd: 1, spentTodayUsd: 0, exceeded: false },
    });
    expect((await app.inject({ method: 'GET', url: '/stats' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/jobs' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/ai/profile' })).json()).toEqual({ resumes: [], profiles: [], tasks: [] });
  });
});

describe('POST /ai/resumes/:lang', () => {
  it('stores the pdf, extracts its text and queues the profile extraction', async () => {
    const res = await post('/ai/resumes/pt-BR', upload(pdf, 'Currículo Maria.pdf'));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      lang: 'pt-BR', fileName: 'Currículo Maria.pdf', mime: 'application/pdf', size: pdf.length, uploadedAt: expect.any(Number),
    });
    const [row] = await db.select().from(resumes);
    expect(row.content.equals(pdf)).toBe(true);
    expect(row.extractedText).toBe(SAMPLE_RESUME_TEXT);
    expect(await tasks()).toMatchObject([{ type: 'profile_extract', lang: 'pt-BR', status: 'queued', subject: 'lang:pt-BR' }]);

    const overview = (await app.inject({ method: 'GET', url: '/ai/profile' })).json();
    expect(overview.resumes).toEqual([res.json()]);
    expect(overview.tasks).toMatchObject([{ type: 'profile_extract', status: 'queued', lang: 'pt-BR' }]);
  });

  it('accepts a docx under /api and replaces the previous file of the same language', async () => {
    await post('/api/ai/resumes/en', upload(pdf));
    const docx = makeDocx(SAMPLE_RESUME_TEXT);
    const res = await post('/api/ai/resumes/en', upload(docx, 'resume.docx'));
    expect(res.statusCode).toBe(201);
    expect(res.json().mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(await db.select({ lang: resumes.lang }).from(resumes)).toEqual([{ lang: 'en' }]);
    // A extração já estava na fila: não duplica.
    expect(await tasks()).toHaveLength(1);
  });

  it('decides the type by content: a zip named .pdf and a pdf declared as text are told apart', async () => {
    const disguised = await post('/ai/resumes/en', upload(makePlainZip(), 'cv.pdf', 'application/pdf'));
    expect(disguised.statusCode).toBe(400);
    expect(disguised.json().error).toBe('unsupported_type');
    expect((await post('/ai/resumes/en', upload(Buffer.from('texto puro'), 'cv.docx'))).statusCode).toBe(400);
    expect((await post('/ai/resumes/en', upload(pdf, 'cv.txt', 'text/plain'))).statusCode).toBe(201);
  });

  it('refuses an image-only pdf with a clear message and stores nothing', async () => {
    const res = await post('/ai/resumes/pt-BR', upload(await makeImageOnlyPdf()));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'unreadable_resume', message: expect.stringContaining('não tem texto extraível') });
    expect(await db.select({ lang: resumes.lang }).from(resumes)).toHaveLength(0);
    expect(await tasks()).toHaveLength(0);
  });

  it('refuses a file above 5 MiB with 413', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(LIMITS.resumeBytes)]);
    const res = await post('/ai/resumes/pt-BR', upload(big));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('bad_request');
    expect(await db.select({ lang: resumes.lang }).from(resumes)).toHaveLength(0);
  });

  it('refuses an unknown language, a json body and a request without file', async () => {
    expect((await post('/ai/resumes/es', upload(pdf))).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/ai/resumes/en', payload: { file: 'x' } })).statusCode).toBe(400);
    const empty = { headers: { 'content-type': 'multipart/form-data; boundary=b' }, payload: '--b--\r\n' };
    expect((await app.inject({ method: 'POST', url: '/ai/resumes/en', ...empty })).statusCode).toBe(400);
  });

  it('never keeps the path sent by the client in the file name', async () => {
    const res = await post('/ai/resumes/en', upload(pdf, '..\\\\..\\\\windows\\\\cv.pdf'));
    expect(res.json().fileName).toBe('cv.pdf');
  });

  it('answers 409 when AI is not configured', async () => {
    app = buildApp(db, { ai: testAi({ env: NO_AI_ENV }) });
    const res = await post('/ai/resumes/en', upload(pdf));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ai_not_configured');
  });

  it('keeps the cross-origin guard and the 1 MiB json limit of the core', async () => {
    const body = upload(pdf);
    const crossOrigin = await app.inject({
      method: 'POST', url: '/ai/resumes/en', payload: body.payload,
      headers: { ...body.headers, origin: 'https://evil.example', host: 'localhost:3333' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(await db.select({ lang: resumes.lang }).from(resumes)).toHaveLength(0);

    const hugeJson = await app.inject({ method: 'POST', url: '/profiles', payload: { name: 'x'.repeat(1_100_000) } });
    expect(hugeJson.statusCode).toBe(413);
    expect(await db.select().from(searchProfiles)).toHaveLength(0);
  });

  it('serves the original file back as an attachment', async () => {
    await post('/ai/resumes/en', upload(pdf));
    const res = await app.inject({ method: 'GET', url: '/ai/resumes/en/file' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="curriculo-en.pdf"');
    expect(res.rawPayload.equals(pdf)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/ai/resumes/pt-BR/file' })).statusCode).toBe(404);
  });
});

describe('profile editing and translation', () => {
  const put = (lang: string, data: unknown) => app.inject({ method: 'PUT', url: `/ai/profile/${lang}`, payload: { data } });

  it('saves an edit with a new version, keeping ids and creating ids for new items', async () => {
    const first = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const edited = { ...SAMPLE_PROFILE, summary: 'Resumo revisado.', skills: [...SAMPLE_PROFILE.skills, { id: '', name: 'Vitest' }] };
    const res = await put('pt-BR', edited);
    expect(res.statusCode).toBe(200);
    const dto = res.json();
    expect(dto).toMatchObject({ lang: 'pt-BR', origin: 'editado', version: first.version + 1 });
    expect(dto.data.summary).toBe('Resumo revisado.');
    expect(dto.data.skills.slice(0, 3)).toEqual(SAMPLE_PROFILE.skills);
    expect(dto.data.skills[3]).toEqual({ id: expect.stringMatching(/^skill_[a-z0-9]{8}$/), name: 'Vitest' });
    expect(dto.data.experiences[0].id).toBe('exp_aaaaaaa1');
  });

  it('rejects text above the limits, NUL characters and an unknown profile', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    expect((await put('pt-BR', { ...SAMPLE_PROFILE, summary: 'x'.repeat(LIMITS.profileLong + 1) })).statusCode).toBe(400);
    expect((await put('pt-BR', { ...SAMPLE_PROFILE, summary: 'a\u0000b' })).statusCode).toBe(400);
    expect((await put('pt-BR', { summary: 'faltam campos' })).statusCode).toBe(400);
    expect((await put('en', SAMPLE_PROFILE)).statusCode).toBe(404);
  });

  it('queues a translation only from an existing profile and never over a reviewed one', async () => {
    const translate = (lang: string) => app.inject({ method: 'POST', url: `/ai/profile/${lang}/translate` });
    expect((await translate('en')).statusCode).toBe(409);
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const res = await translate('en');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true });
    expect((await translate('en')).json()).toEqual({ queued: false });
    expect(await tasks()).toMatchObject([{ type: 'profile_translate', lang: 'en', status: 'queued' }]);

    await db.update(aiTasks).set({ status: 'ok' });
    await saveProfile(db, 'en', SAMPLE_PROFILE, 'traduzido');
    expect((await translate('en')).statusCode).toBe(202);
    await db.update(aiTasks).set({ status: 'ok' });
    await saveProfile(db, 'en', SAMPLE_PROFILE, 'editado');
    expect((await translate('en')).statusCode).toBe(409);
  });
});

describe('POST /ai/tasks/:id/confirm', () => {
  it('releases a budget-blocked task and answers 404 for anything else', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    await app.inject({ method: 'POST', url: '/ai/profile/en/translate' });
    const [task] = await tasks();
    const confirm = (id: number | string) => app.inject({ method: 'POST', url: `/ai/tasks/${id}/confirm` });
    expect((await confirm(task.id)).statusCode).toBe(404);
    await db.update(aiTasks).set({ status: 'blocked_budget' }).where(eq(aiTasks.id, task.id));
    expect((await confirm(task.id)).statusCode).toBe(202);
    expect((await tasks())[0]).toMatchObject({ status: 'queued', confirmed: true });
    expect((await confirm('abc')).statusCode).toBe(404);
  });
});
