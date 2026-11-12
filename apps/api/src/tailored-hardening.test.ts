import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resolveTailored } from '@kv/ai';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import { closeDb, jobAi, saveProfile, tailoredResumes, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { ResumePdfError } from '@kv/resume';
import { draftOf, type TailoredDraft, type Violation } from '@kv/shared';
import { seedJob, testAi } from './ai-testing';
import { buildApp } from './app';
import { blocksEdit } from './routes/tailored';

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

async function seedTailored(jobOver: Parameters<typeof seedJob>[1] = {}) {
  const profile = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
  const job = await seedJob(db, jobOver);
  const { resume } = resolveTailored(fullDraft(), SAMPLE_PROFILE, 'pt-BR');
  await db.insert(tailoredResumes).values({ jobId: job.id, lang: 'pt-BR', content: resume, profileVersion: profile.version, createdAt: 1 });
  return { job, profile, resume };
}
const state = async (id: number) => (await app.inject({ method: 'GET', url: `/jobs/${id}/tailored` })).json();
const put = (id: number, body: object) => app.inject({ method: 'PUT', url: `/jobs/${id}/tailored`, payload: body });
const pdfOf = (id: number) => app.inject({ method: 'GET', url: `/jobs/${id}/tailored.pdf` });
const codes = (vs: { code: string }[]) => vs.map((v) => v.code);

describe('blocksEdit', () => {
  const v = (code: Violation['code']): Violation => ({ code, path: 'summary', message: 'm' });
  it('blocks structural violations and limits; everything else is a warning for the user', () => {
    for (const code of ['unknown_id', 'duplicate_id', 'limit'] as const) expect(blocksEdit(v(code))).toBe(true);
    for (const code of ['new_number', 'foreign_company', 'novel_term', 'unrelated_text'] as const) expect(blocksEdit(v(code))).toBe(false);
  });
});

describe('PUT /jobs/:id/tailored uses the job as context', () => {
  it('warns (and saves) about a keyword of the tier-2 analysis and a word of the job title that are not in the profile', async () => {
    const { job, resume } = await seedTailored({ title: 'Analista de Observabilidade' });
    await db.insert(jobAi).values({
      jobId: job.id, tier2State: 'ok', tier2ProfileVersion: 1,
      analysis: { strengths: [], gaps: [], keywordsPresent: [], keywordsMissing: ['microsserviços'], interviewTopics: [], likelyQuestions: [] },
    });
    const edit = { ...draftOf(resume), summary: `${SAMPLE_PROFILE.summary} Atuei com microsserviços e observabilidade.` };
    const res = await put(job.id, edit);
    expect(res.statusCode).toBe(200);
    const novel = res.json().warnings.filter((w: Violation) => w.code === 'novel_term').map((w: Violation) => w.detail?.toLowerCase());
    expect(novel).toEqual(expect.arrayContaining(['microsserviços', 'observabilidade']));
    expect((await state(job.id)).tailored.editedAt).toEqual(expect.any(Number));
  });

  it('without a tier-2 analysis only the structure, the company and the numbers are checked, as before', async () => {
    const { job, resume } = await seedTailored({ title: 'Vaga' });
    const res = await put(job.id, { ...draftOf(resume), summary: `${SAMPLE_PROFILE.summary} Atuei com microsserviços.` });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual([]);
  });
});

describe('pdfWarnings on the tailored resume', () => {
  it('is empty for a plain résumé, in the GET and in the PUT', async () => {
    const { job, resume } = await seedTailored();
    expect((await state(job.id)).tailored.pdfWarnings).toEqual({ unsupportedCharacters: [], tooLong: false });
    const saved = await put(job.id, draftOf(resume));
    expect(saved.json().tailored.pdfWarnings).toEqual({ unsupportedCharacters: [], tooLong: false });
    expect((await state(job.id)).tailored.pdfWarnings.unsupportedCharacters).toEqual([]);
    expect(await app.inject({ method: 'GET', url: '/jobs/999/tailored' })).toMatchObject({ statusCode: 404 });
  });

  it('lists the characters that no embedded font can draw, before the user asks for the pdf', async () => {
    const { job, resume } = await seedTailored();
    const res = await put(job.id, { ...draftOf(resume), summary: `${SAMPLE_PROFILE.summary} 日本 ✓` });
    expect(res.statusCode).toBe(200);
    expect(res.json().tailored.pdfWarnings).toEqual({ unsupportedCharacters: expect.arrayContaining(['日', '本', '✓']), tooLong: false });
    expect((await state(job.id)).tailored.pdfWarnings.unsupportedCharacters).toEqual(expect.arrayContaining(['日']));
  });

  it('says tooLong when the text is above the renderer limit, without throwing', async () => {
    const { job, resume } = await seedTailored();
    await db.update(tailoredResumes).set({ content: { ...resume, summary: 'palavra '.repeat(15_000) } }).where(eq(tailoredResumes.jobId, job.id));
    expect((await state(job.id)).tailored.pdfWarnings).toEqual({ unsupportedCharacters: [], tooLong: true });
  });
});

describe('GET /jobs/:id/tailored.pdf', () => {
  it('answers 422 with a Portuguese message, the code and the characters when the font lacks a glyph', async () => {
    const { job, resume } = await seedTailored();
    await put(job.id, { ...draftOf(resume), summary: `${SAMPLE_PROFILE.summary} 日本` });
    const res = await pdfOf(job.id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'pdf_unavailable', code: 'unsupported_characters', characters: ['日', '本'], message: expect.stringContaining('Edite o currículo'),
    });
  });

  it('answers 422 too_long when the renderer refuses the size', async () => {
    const { job } = await seedTailored();
    app = buildApp(db, {
      ai: testAi({
        renderPdf: async () => {
          throw new ResumePdfError('too_long', 'O currículo tem texto demais para virar PDF. Encurte o resumo e as realizações.');
        },
      }),
    });
    const res = await pdfOf(job.id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'pdf_unavailable', code: 'too_long', message: expect.stringContaining('texto demais') });
  });

  it('does not turn any other failure into a 422', async () => {
    const { job } = await seedTailored();
    app = buildApp(db, { ai: testAi({ renderPdf: async () => Promise.reject(new Error('disco cheio')) }) });
    const res = await pdfOf(job.id);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'erro interno' });
  });

  it('renders one pdf at a time, however many requests arrive together', async () => {
    const { job } = await seedTailored();
    let active = 0;
    let peak = 0;
    let calls = 0;
    app = buildApp(db, {
      ai: testAi({
        renderPdf: async () => {
          calls++;
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 15));
          active--;
          return Buffer.from('%PDF-1.4 fake');
        },
      }),
    });
    const results = await Promise.all(Array.from({ length: 6 }, () => pdfOf(job.id)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(calls).toBe(6);
    expect(peak).toBe(1);
  });

  it('keeps going after a render failed: the next request still renders', async () => {
    const { job } = await seedTailored();
    let n = 0;
    app = buildApp(db, {
      ai: testAi({
        renderPdf: async () => {
          if (n++ === 0) throw new Error('falhou');
          return Buffer.from('%PDF-ok');
        },
      }),
    });
    expect((await pdfOf(job.id)).statusCode).toBe(500);
    expect((await pdfOf(job.id)).statusCode).toBe(200);
  });

  it('enforces the text limits before rendering: a summary above the limit never reaches the renderer', async () => {
    const { job, resume } = await seedTailored();
    await db.update(tailoredResumes).set({ content: { ...resume, summary: 'x'.repeat(2_500) } }).where(eq(tailoredResumes.jobId, job.id));
    let rendered = 0;
    app = buildApp(db, { ai: testAi({ renderPdf: async () => (rendered++, Buffer.from('%PDF-')) }) });
    const res = await pdfOf(job.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'verification_failed', violations: [{ code: 'limit', path: 'summary' }] });
    expect(rendered).toBe(0);
  });

  it('re-checks against the current profile: a reference that no longer exists blocks the pdf with the violations', async () => {
    const { job } = await seedTailored();
    // O usuário apagou uma realização do perfil depois de o currículo adaptado ser salvo.
    const trimmed = { ...SAMPLE_PROFILE, experiences: [{ ...SAMPLE_PROFILE.experiences[0], achievements: SAMPLE_PROFILE.experiences[0].achievements.slice(0, 1) }] };
    await saveProfile(db, 'pt-BR', trimmed, 'editado');
    const res = await pdfOf(job.id);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({ error: 'verification_failed', message: expect.stringContaining('ach_aaaaaaa2') });
    expect(codes(body.violations)).toEqual(['unknown_id']);
  });

  it('a model draft that no longer verifies is blocked, and becomes a warning once the user reviewed and saved it', async () => {
    const { job, resume } = await seedTailored();
    // A realização original mudou: o "40%" do rascunho deixou de existir no perfil.
    const changed = {
      ...SAMPLE_PROFILE,
      experiences: [{
        ...SAMPLE_PROFILE.experiences[0],
        achievements: [{ id: 'ach_aaaaaaa1', text: 'Reduzi o tempo de build com a migração para Vite' }, SAMPLE_PROFILE.experiences[0].achievements[1]],
      }],
    };
    await saveProfile(db, 'pt-BR', changed, 'editado');
    const blocked = await pdfOf(job.id);
    expect(blocked.statusCode).toBe(409);
    expect(codes(blocked.json().violations)).toContain('new_number');
    expect(blocked.json().message).toMatch(/Revise/);

    // O usuário revisa e salva: o texto passa a ser dele; número novo é só aviso e o PDF sai.
    const saved = await put(job.id, draftOf(resume));
    expect(saved.statusCode).toBe(200);
    expect(codes(saved.json().warnings)).toContain('new_number');
    expect((await pdfOf(job.id)).statusCode).toBe(200);
  });

  it('a reviewed résumé still renders when only warnings remain, and the context of the job is used', async () => {
    const { job, resume } = await seedTailored({ title: 'Analista de Observabilidade' });
    await put(job.id, { ...draftOf(resume), summary: `${SAMPLE_PROFILE.summary} Trabalho com observabilidade.` });
    const res = await pdfOf(job.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });
});

describe('staleness is judged against the profile row that was used', () => {
  it('a tailored résumé goes stale only when the profile of ITS language changes', async () => {
    const pt = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const en = await saveProfile(db, 'en', SAMPLE_PROFILE, 'traduzido');
    const job = await seedJob(db, { country: 'INT' });
    await db.insert(jobAi).values({ jobId: job.id, language: 'en' });
    const { resume } = resolveTailored(fullDraft(), SAMPLE_PROFILE, 'en');
    await db.insert(tailoredResumes).values({ jobId: job.id, lang: 'en', content: resume, profileVersion: en.version, createdAt: 1 });
    expect((await state(job.id)).tailored).toMatchObject({ stale: false, profileVersion: en.version });

    // Editar o perfil em português sobe a versão global, mas não toca no perfil em inglês.
    await saveProfile(db, 'pt-BR', { ...SAMPLE_PROFILE, summary: 'Outro resumo.' }, 'editado');
    expect((await state(job.id)).tailored.stale).toBe(false);
    expect(pt.version).toBeLessThan(en.version);

    await saveProfile(db, 'en', { ...SAMPLE_PROFILE, summary: 'Another summary.' }, 'editado');
    expect((await state(job.id)).tailored.stale).toBe(true);
    expect((await state(job.id)).state).toBe('stale');
  });

  it('the scores and the analysis follow the base profile (pt-BR first), not the other language', async () => {
    const pt = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    await saveProfile(db, 'en', SAMPLE_PROFILE, 'traduzido');
    const job = await seedJob(db);
    await db.insert(jobAi).values({
      jobId: job.id, tier1State: 'ok', tier1ProfileVersion: pt.version, score: 70, language: 'pt', titlePt: 'x', reason: 'r',
      tier2State: 'ok', tier2ProfileVersion: pt.version,
    });
    const detail = async () => (await app.inject({ method: 'GET', url: `/jobs/${job.id}/ai` })).json();
    expect((await detail()).tier2.state).toBe('ok');
    // Editar o perfil em inglês não invalida nota nem análise.
    await saveProfile(db, 'en', { ...SAMPLE_PROFILE, summary: 'Edited.' }, 'editado');
    expect((await detail()).tier2.state).toBe('ok');
    expect((await app.inject({ method: 'GET', url: '/jobs/ai' })).json()[0].stale).toBe(false);
    await saveProfile(db, 'pt-BR', { ...SAMPLE_PROFILE, summary: 'Editado.' }, 'editado');
    expect((await detail()).tier2.state).toBe('stale');
    expect((await app.inject({ method: 'GET', url: '/jobs/ai' })).json()[0].stale).toBe(true);
  });
});
