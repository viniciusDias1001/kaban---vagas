import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveTailored } from '@kv/ai';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import { aiTasks, closeDb, jobAi, saveProfile, tailoredResumes, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { extractResumeText } from '@kv/resume';
import { draftOf, type TailoredDraft } from '@kv/shared';
import { CONTENT_SECURITY_POLICY, buildApp } from './app';
import { NO_AI_ENV, seedJob, testAi } from './ai-testing';

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

const fullDraft = (): TailoredDraft => ({
  summary: SAMPLE_PROFILE.summary,
  experiences: SAMPLE_PROFILE.experiences.map((e) => ({ id: e.id, achievements: e.achievements.map((a) => ({ sourceId: a.id, text: a.text })) })),
  educationIds: ['edu_aaaaaaa1'], skillIds: ['skill_aaaaaaa1', 'skill_aaaaaaa2'], languageIds: ['lang_aaaaaaa1'],
  certificationIds: [], linkIds: [],
});

/** Vaga brasileira com perfil pt-BR e um currículo adaptado já gerado (como o worker grava). */
async function seedTailored() {
  const profile = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
  const job = await seedJob(db);
  const { resume } = resolveTailored(fullDraft(), SAMPLE_PROFILE, 'pt-BR');
  await db.insert(tailoredResumes).values({ jobId: job.id, lang: 'pt-BR', content: resume, profileVersion: profile.version, createdAt: 1 });
  return { job, profile, resume };
}

const state = async (id: number) => (await app.inject({ method: 'GET', url: `/jobs/${id}/tailored` })).json();
const request = (id: number | string) => app.inject({ method: 'POST', url: `/jobs/${id}/tailored` });

describe('POST /jobs/:id/tailored ("Adaptar currículo")', () => {
  it('queues tier 3 and reports the progress', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const job = await seedJob(db);
    expect(await state(job.id)).toEqual({ state: 'none', task: null, tailored: null });
    const res = await request(job.id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true });
    expect((await request(job.id)).json()).toEqual({ queued: false });
    expect(await state(job.id)).toMatchObject({ state: 'queued', task: { type: 'tier3', jobId: job.id }, tailored: null });
    await db.update(aiTasks).set({ status: 'blocked_budget' });
    expect((await state(job.id)).state).toBe('blocked_budget');
    await db.update(aiTasks).set({ status: 'error', error: 'verificação de não invenção bloqueou: summary: o número "10" não está no perfil' });
    expect(await state(job.id)).toMatchObject({ state: 'error', task: { error: expect.stringContaining('não invenção') } });
  });

  it('uses the language of the job and asks for the missing profile', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const abroad = await seedJob(db, { country: 'INT' });
    const res = await request(abroad.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'profile_missing', message: expect.stringContaining('inglês') });
    // O idioma detectado pela IA vale mais que o país da vaga.
    await db.insert(jobAi).values({ jobId: abroad.id, language: 'pt' });
    expect((await request(abroad.id)).statusCode).toBe(202);
  });

  it('reuses a tailored resume made with the current profile and regenerates a stale one', async () => {
    const { job } = await seedTailored();
    expect((await request(job.id)).statusCode).toBe(200);
    expect(await db.select().from(aiTasks)).toHaveLength(0);
    expect(await state(job.id)).toMatchObject({ state: 'ok', tailored: { stale: false, lang: 'pt-BR', editedAt: null } });

    await saveProfile(db, 'pt-BR', { ...SAMPLE_PROFILE, summary: 'Mudou.' }, 'editado');
    expect(await state(job.id)).toMatchObject({ state: 'stale', tailored: { stale: true } });
    expect((await request(job.id)).statusCode).toBe(202);
  });

  it('answers 404 for an unknown job and 409 without a provider', async () => {
    expect((await request(999)).statusCode).toBe(404);
    const job = await seedJob(db);
    app = buildApp(db, { ai: testAi({ env: NO_AI_ENV }) });
    expect((await request(job.id)).statusCode).toBe(409);
  });
});

describe('PUT /jobs/:id/tailored (review and edit)', () => {
  const put = (id: number, body: object) => app.inject({ method: 'PUT', url: `/jobs/${id}/tailored`, payload: body });

  it('saves the edited text and re-copies company, title and dates from the profile', async () => {
    const { job, resume } = await seedTailored();
    const edit = draftOf(resume);
    edit.summary = 'Resumo escrito por mim.';
    edit.skillIds = ['skill_aaaaaaa2'];
    edit.experiences[0].achievements = [{ sourceId: 'ach_aaaaaaa1', text: 'Migrei o build para Vite: 40% mais rápido' }];
    const res = await put(job.id, edit);
    expect(res.statusCode).toBe(200);
    const { tailored, warnings } = res.json();
    expect(warnings).toEqual([]);
    expect(tailored.editedAt).toEqual(expect.any(Number));
    expect(tailored.content.summary).toBe('Resumo escrito por mim.');
    expect(tailored.content.skills).toEqual([{ id: 'skill_aaaaaaa2', name: 'TypeScript', group: '' }]);
    expect(tailored.content.experiences[0]).toMatchObject({ company: 'Empresa Fictícia Ltda', start: '2021-03' });
    expect(tailored.content.experiences[0].achievements).toHaveLength(1);
  });

  it('warns about a new number or the hiring company, but saves: the text is now the user\'s', async () => {
    const { job, resume } = await seedTailored();
    const edit = { ...draftOf(resume), summary: 'Tenho 12 anos de experiência e quero trabalhar na Acme Fictícia.' };
    const res = await put(job.id, edit);
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.map((w: { code: string }) => w.code)).toEqual(['new_number', 'foreign_company']);
    expect((await state(job.id)).tailored.content.summary).toContain('12 anos');
  });

  it('refuses ids that are not in the profile, extra fields and oversized text', async () => {
    const { job, resume } = await seedTailored();
    const unknownSkill = await put(job.id, { ...draftOf(resume), skillIds: ['skill_kubernetes'] });
    expect(unknownSkill.statusCode).toBe(400);
    expect(unknownSkill.json()).toEqual({ error: 'validation', message: expect.stringContaining('skill_kubernetes') });
    const withCompany = { ...draftOf(resume), experiences: [{ ...draftOf(resume).experiences[0], company: 'Google' }] };
    expect((await put(job.id, withCompany)).statusCode).toBe(400);
    expect((await put(job.id, { ...draftOf(resume), summary: 'x'.repeat(2_001) })).statusCode).toBe(400);
    expect((await state(job.id)).tailored.editedAt).toBeNull();
  });

  it('answers 404 when the job has no tailored resume', async () => {
    const job = await seedJob(db);
    expect((await put(job.id, fullDraft())).statusCode).toBe(404);
  });
});

describe('GET /jobs/:id/tailored.pdf', () => {
  it('downloads a pdf with selectable text, from the same origin, as an attachment', async () => {
    const { job } = await seedTailored();
    for (const url of [`/jobs/${job.id}/tailored.pdf`, `/api/jobs/${job.id}/tailored.pdf`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="curriculo-vaga-${job.id}.pdf"`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-store');
      const text = await extractResumeText(res.rawPayload, 'pdf');
      expect(text.ok && text.text).toContain('Maria Exemplo da Silva');
      expect(text.ok && text.text).toContain('Empresa Fictícia Ltda');
    }
  });

  it('needs no change to the content security policy of the pages', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:/);
  });

  it('answers 404 without a tailored resume or for an unknown job', async () => {
    const job = await seedJob(db);
    expect((await app.inject({ method: 'GET', url: `/jobs/${job.id}/tailored.pdf` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/jobs/999/tailored.pdf' })).statusCode).toBe(404);
  });
});
