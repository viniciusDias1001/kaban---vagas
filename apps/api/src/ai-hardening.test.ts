import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AiError, RESUME_TEXT_MAX_CHARS, resumeTextChars, type AiProvider } from '@kv/ai';
import { SAMPLE_RESUME_TEXT } from '@kv/ai/testing';
import { aiTasks, aiUsage, closeDb, resumes, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { EXTRACT_LIMITS, RESUME_MIME } from '@kv/resume';
import { makeDocx, makePlainZip, makeTextPdf } from '@kv/resume/testing';
import { SecretInputError } from '@kv/settings';
import { TEST_SECRET, testAi, upload } from './ai-testing';
import { buildApp } from './app';

let db: Db;
let app: ReturnType<typeof buildApp>;
const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

beforeAll(async () => {
  db = await createTestDb();
  pdf = await makeTextPdf(SAMPLE_RESUME_TEXT);
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi() });
});
afterAll(() => closeDb(db));

let pdf: Buffer;
const post = (url: string, body: ReturnType<typeof upload>) => app.inject({ method: 'POST', url, ...body });
const tasks = () => db.select().from(aiTasks);

describe('résumé upload', () => {
  const failing = (reason: 'no_text' | 'too_many_pages' | 'too_large' | 'invalid' | 'timeout', message = 'ENOENT: /srv/app/node_modules/pdfjs/secret.js at parse (line 42)') =>
    buildApp(db, { ai: testAi({ extractResume: async () => ({ ok: false, reason, message }) }) });

  it.each([
    ['invalid', /não é um PDF válido/],
    ['no_text', /não tem texto extraível/],
    ['too_many_pages', new RegExp(`limite é ${EXTRACT_LIMITS.maxPages}`)],
    ['too_large', /grande demais|memória/],
    ['timeout', /demorou demais/],
  ] as const)('answers a fixed message for the extraction failure "%s", never the parser text', async (reason, pattern) => {
    app = failing(reason);
    const res = await post('/ai/resumes/en', upload(pdf));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'unreadable_resume', message: expect.stringMatching(pattern) });
    expect(res.body).not.toMatch(/ENOENT|node_modules|secret\.js|line 42/);
    expect(await db.select().from(resumes)).toHaveLength(0);
    expect(await tasks()).toHaveLength(0);
  });

  it('names the file type in the "invalid" message', async () => {
    app = failing('invalid');
    const docx = await post('/ai/resumes/en', upload(makeDocx(SAMPLE_RESUME_TEXT), 'cv.docx'));
    expect(docx.json().message).toMatch(/DOCX/);
  });

  it('refuses a résumé whose text is longer than the AI can read, with the limit in pages, and queues nothing', async () => {
    const lines = Array.from({ length: Math.ceil(RESUME_TEXT_MAX_CHARS / 12) + 50 }, (_, i) => `linha numero ${i}`);
    const text = lines.join('\n');
    expect(resumeTextChars(text)).toBeGreaterThan(RESUME_TEXT_MAX_CHARS);
    app = buildApp(db, { ai: testAi({ extractResume: async () => ({ ok: true, text }) }) });
    const res = await post('/ai/resumes/pt-BR', upload(pdf));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'resume_too_long', message: expect.stringMatching(/cerca de 6 páginas/) });
    expect(await db.select().from(resumes)).toHaveLength(0);
    expect(await tasks()).toHaveLength(0);
  });

  it('measures the length the way the AI package does: spaces are compacted, and the limit itself is accepted', async () => {
    const padded = `${'x'.repeat(RESUME_TEXT_MAX_CHARS - 100)}${' '.repeat(5_000)}${'y'.repeat(99)}`;
    expect(padded.length).toBeGreaterThan(RESUME_TEXT_MAX_CHARS);
    expect(resumeTextChars(padded)).toBeLessThanOrEqual(RESUME_TEXT_MAX_CHARS);
    app = buildApp(db, { ai: testAi({ extractResume: async () => ({ ok: true, text: padded }) }) });
    expect((await post('/ai/resumes/pt-BR', upload(pdf))).statusCode).toBe(201);
    expect(await tasks()).toHaveLength(1);
  });

  it('stores the MIME type of the sniffed kind, whatever the client declared', async () => {
    await post('/ai/resumes/en', upload(pdf, 'x.html', 'text/html'));
    expect((await db.select().from(resumes))[0].mime).toBe(RESUME_MIME.pdf);
    await post('/ai/resumes/en', upload(makeDocx(SAMPLE_RESUME_TEXT), 'x.pdf', 'application/pdf'));
    expect((await db.select().from(resumes))[0].mime).toBe(RESUME_MIME.docx);
    expect((await post('/ai/resumes/en', upload(makePlainZip(), 'x.docx', RESUME_MIME.docx))).statusCode).toBe(400);
  });

  it('never serves a stored file inline: attachment, nosniff, and only the two known types', async () => {
    await post('/ai/resumes/en', upload(pdf));
    for (const mime of [RESUME_MIME.pdf, 'text/html', 'image/svg+xml']) {
      await db.update(resumes).set({ mime }).where(eq(resumes.lang, 'en'));
      const res = await app.inject({ method: 'GET', url: '/ai/resumes/en/file' });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="curriculo-en\.(pdf|docx|bin)"$/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-type']).toBe(mime === RESUME_MIME.pdf ? RESUME_MIME.pdf : 'application/octet-stream');
      expect(res.headers['content-security-policy']).toContain('sandbox');
    }
  });
});

describe('typed errors', () => {
  it('maps a SecretInputError to 400 with its fixed message', async () => {
    const stub = {
      status: async () => ({ configured: true, problem: null }),
      saveKey: async () => {
        throw new SecretInputError('empty_key');
      },
    };
    app = buildApp(db, { ai: testAi({ settings: stub as never }) });
    const res = await app.inject({ method: 'PUT', url: '/settings/ai-keys/openai', payload: { key: 'sk-test-ficticia-1234567' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'validation', message: 'a chave de API está vazia' });
  });
});

describe('POST /settings/ai/test records the usage of a billed call that failed', () => {
  async function ready(provider: AiProvider) {
    app = buildApp(db, { ai: testAi({ env: { APP_SECRET: TEST_SECRET }, now: () => NOW, createProvider: () => provider }) });
    await app.inject({ method: 'PUT', url: '/settings/ai-keys/openai', payload: { key: 'sk-test-ficticia-1234567' } });
    await app.inject({ method: 'PATCH', url: '/settings', payload: { provider: 'openai' } });
  }
  const failWith = (error: AiError): AiProvider => ({
    id: 'openai',
    async generate() {
      throw error;
    },
  });

  it('a truncated test answer is billed: the usage row exists and the outcome is still "ok"', async () => {
    await ready(failWith(new AiError('truncated', 'cortada', undefined, { usage: { inputTokens: 30, outputTokens: 16 }, model: 'gpt-6-luna' })));
    const res = await app.inject({ method: 'POST', url: '/settings/ai/test' });
    expect(res.json().outcome).toBe('ok');
    expect(await db.select().from(aiUsage)).toMatchObject([{ layer: 'test', model: 'gpt-6-luna', inputTokens: 30, outputTokens: 16 }]);
  });

  it('a refusal that was billed is recorded under the configured fast model when the provider did not name one', async () => {
    await ready(failWith(new AiError('refused', 'recusa', undefined, { usage: { inputTokens: 5, outputTokens: 1 } })));
    expect((await app.inject({ method: 'POST', url: '/settings/ai/test' })).json().outcome).toBe('refused');
    expect(await db.select().from(aiUsage)).toMatchObject([{ layer: 'test', model: 'gpt-6-luna', inputTokens: 5 }]);
  });

  it('a failure before any response records nothing', async () => {
    await ready(failWith(new AiError('transient', 'rede')));
    expect((await app.inject({ method: 'POST', url: '/settings/ai/test' })).json().outcome).toBe('network');
    expect(await db.select().from(aiUsage)).toHaveLength(0);
  });
});
