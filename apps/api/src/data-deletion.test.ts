import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTailored } from '@kv/ai';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import {
  aiKeys, aiTasks, aiUsage, candidateProfiles, closeDb, enqueueAiTask, jobAi, jobs, recordUsage, resumes, saveProfile, tailoredResumes,
  type Db,
} from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import type { ResumeLang } from '@kv/shared';
import { TEST_SECRET, seedJob, testAi } from './ai-testing';
import { buildApp } from './app';
import { removeApplyFiles } from './routes/ai';

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi({ env: { AI_PROVIDER: 'fake', APP_SECRET: TEST_SECRET } }) });
});
afterAll(() => closeDb(db));

/** Tudo o que a IA de perfil guarda: currículos e perfis dos dois idiomas, notas, currículos adaptados, tarefas e uso. */
async function seedEverything() {
  for (const lang of ['pt-BR', 'en'] as ResumeLang[]) {
    await db.insert(resumes).values({
      lang, fileName: `cv-${lang}.pdf`, mime: 'application/pdf', content: Buffer.from('%PDF-1.4 conteudo ficticio'), extractedText: 'Maria Exemplo', uploadedAt: NOW,
    });
  }
  const pt = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOW);
  const en = await saveProfile(db, 'en', SAMPLE_PROFILE, 'traduzido', NOW);
  const br = await seedJob(db, { externalId: 'br' });
  const abroad = await seedJob(db, { externalId: 'int', country: 'INT' });
  for (const [job, lang, profile] of [[br, 'pt-BR', pt], [abroad, 'en', en]] as const) {
    const { resume } = resolveTailored(
      { summary: SAMPLE_PROFILE.summary, experiences: [], educationIds: [], skillIds: [], languageIds: [], certificationIds: [], linkIds: [] },
      SAMPLE_PROFILE, lang,
    );
    await db.insert(tailoredResumes).values({ jobId: job.id, lang, content: resume, profileVersion: profile.version, createdAt: NOW });
    await db.insert(jobAi).values({
      jobId: job.id, language: lang === 'en' ? 'en' : 'pt', titlePt: 'Dev', score: 80, reason: 'r', tier1State: 'ok', tier1ProfileVersion: pt.version,
    });
  }
  await enqueueAiTask(db, { type: 'profile_extract', lang: 'pt-BR' }, NOW);
  await enqueueAiTask(db, { type: 'profile_translate', lang: 'en' }, NOW);
  await enqueueAiTask(db, { type: 'tier2', jobId: br.id }, NOW);
  await db.insert(aiTasks).values({ type: 'profile_extract', subject: 'lang:pt-BR', lang: 'pt-BR', status: 'error', error: 'x', createdAt: 1, finishedAt: 2 });
  await recordUsage(db, { provider: 'fake', model: 'fake-strong', layer: 'profile', inputTokens: 10, outputTokens: 10, costUsd: 0.25, createdAt: NOW });
  return { br, abroad, pt, en };
}
const del = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'DELETE', url, headers });
const langs = async (table: typeof resumes | typeof candidateProfiles | typeof tailoredResumes) =>
  (await db.select({ lang: table.lang }).from(table)).map((r) => r.lang).sort();
const taskList = async () => (await db.select().from(aiTasks)).map((t) => `${t.type}:${t.subject}:${t.status}`).sort();

describe('DELETE /ai/resumes/:lang', () => {
  it('removes the file, the extracted text, the profile, the tailored résumés and the profile tasks of that language only', async () => {
    const { br } = await seedEverything();
    const res = await del('/api/ai/resumes/pt-BR');
    expect(res.statusCode).toBe(204);
    expect(await langs(resumes)).toEqual(['en']);
    expect(await langs(candidateProfiles)).toEqual(['en']);
    expect(await langs(tailoredResumes)).toEqual(['en']);
    // Somem as tarefas de perfil do idioma (pendentes e antigas) e a tradução pendente que LIA este perfil.
    expect(await taskList()).toEqual([`tier2:job:${br.id}:queued`]);
    // O arquivo não pode mais ser baixado e o perfil sumiu da tela.
    expect((await app.inject({ method: 'GET', url: '/ai/resumes/pt-BR/file' })).statusCode).toBe(404);
    const overview = (await app.inject({ method: 'GET', url: '/ai/profile' })).json();
    expect(overview.resumes.map((r: { lang: string }) => r.lang)).toEqual(['en']);
    expect(overview.profiles.map((p: { lang: string }) => p.lang)).toEqual(['en']);
    expect(JSON.stringify(overview.tasks)).not.toContain('pt-BR');
  });

  it('keeps the scores and analyses of the jobs, now flagged as stale (the profile they used is gone)', async () => {
    await seedEverything();
    expect((await app.inject({ method: 'GET', url: '/jobs/ai' })).json().every((s: { stale: boolean }) => !s.stale)).toBe(true);
    await del('/ai/resumes/pt-BR');
    const scores = (await app.inject({ method: 'GET', url: '/jobs/ai' })).json();
    expect(scores).toHaveLength(2);
    expect(scores.every((s: { stale: boolean }) => s.stale)).toBe(true);
  });

  it('answers 404 when there is nothing in that language, 400 for an unknown language, and is behind the origin guard', async () => {
    await seedEverything();
    expect((await del('/ai/resumes/pt-BR', { origin: 'http://evil.example', host: 'localhost:3333' })).statusCode).toBe(403);
    expect(await langs(resumes)).toEqual(['en', 'pt-BR']);
    expect((await del('/ai/resumes/pt-BR')).statusCode).toBe(204);
    expect((await del('/ai/resumes/pt-BR')).statusCode).toBe(404);
    expect((await del('/ai/resumes/fr')).statusCode).toBe(400);
  });

  it('a profile that only came from translation (no file) can be deleted too', async () => {
    await saveProfile(db, 'en', SAMPLE_PROFILE, 'traduzido', NOW);
    expect((await del('/ai/resumes/en')).statusCode).toBe(204);
    expect(await langs(candidateProfiles)).toEqual([]);
  });
});

describe('DELETE /ai/data', () => {
  it('removes résumés, profiles, tailored résumés, job results and every task; keeps usage, settings, keys and jobs', async () => {
    await seedEverything();
    await app.inject({ method: 'PUT', url: '/settings/ai-keys/openai', payload: { key: 'sk-test-uma-chave-ficticia-0001' } });
    await app.inject({ method: 'PATCH', url: '/settings', payload: { dailyBudgetUsd: 3 } });

    const res = await del('/api/ai/data');
    expect(res.statusCode).toBe(204);
    for (const table of [resumes, candidateProfiles, tailoredResumes, jobAi, aiTasks]) {
      expect(await db.select().from(table)).toEqual([]);
    }
    // A contabilidade fica: não tem conteúdo pessoal e é o que faz o limite de gasto de hoje continuar valendo.
    expect(await db.select().from(aiUsage)).toHaveLength(1);
    const status = (await app.inject({ method: 'GET', url: '/ai/status' })).json();
    expect(status.budget).toMatchObject({ dailyUsd: 3, spentTodayUsd: 0.25 });
    expect(await db.select().from(aiKeys)).toHaveLength(1);
    expect(await db.select().from(jobs)).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: '/ai/profile' })).json()).toEqual({ resumes: [], profiles: [], tasks: [] });
    expect((await app.inject({ method: 'GET', url: '/jobs/ai' })).json()).toEqual([]);
  });

  it('removes the photo and résumé folders of the automatic application after the database, never the browser profile', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kv-delete-'));
    try {
      app = buildApp(db, { ai: testAi({ env: { AI_PROVIDER: 'fake', APP_SECRET: TEST_SECRET }, dataDir }) });
      const file = async (...parts: string[]) => {
        await mkdir(join(dataDir, ...parts.slice(0, -1)), { recursive: true });
        await writeFile(join(dataDir, ...parts), 'x');
      };
      await file('shots', '1', 'filled.jpg');
      await file('resumes', '1', 'cv.pdf');
      await file('browser', 'Default', 'Cookies');
      expect((await del('/ai/data')).statusCode).toBe(204);
      expect(existsSync(join(dataDir, 'shots'))).toBe(false);
      expect(existsSync(join(dataDir, 'resumes'))).toBe(false);
      expect(existsSync(join(dataDir, 'browser', 'Default', 'Cookies'))).toBe(true);
      // Sem as pastas (já apagadas), o pedido continua dando certo.
      expect((await del('/ai/data')).statusCode).toBe(204);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('tolerates a file in use while removing the folders', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kv-delete-busy-'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      const removed: string[] = [];
      await expect(removeApplyFiles(dataDir, async (path) => { removed.push(String(path)); throw busy; })).resolves.toBeUndefined();
      // Tentou as duas pastas, mesmo com a primeira em uso.
      expect(removed).toEqual([join(dataDir, 'shots'), join(dataDir, 'resumes')]);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('EBUSY'));
      // Outro erro (não "em uso") não é engolido.
      const denied = Object.assign(new Error('boom'), { code: 'EIO' });
      await expect(removeApplyFiles(dataDir, async () => { throw denied; })).rejects.toThrow('boom');
    } finally {
      spy.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('is behind the origin guard and is idempotent', async () => {
    await seedEverything();
    expect((await del('/ai/data', { origin: 'http://evil.example', host: 'localhost:3333' })).statusCode).toBe(403);
    expect(await langs(resumes)).toEqual(['en', 'pt-BR']);
    expect((await del('/ai/data')).statusCode).toBe(204);
    expect((await del('/ai/data')).statusCode).toBe(204);
  });
});
