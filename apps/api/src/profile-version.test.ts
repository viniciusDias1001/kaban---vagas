import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import { closeDb, profileFor, saveProfile, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { testAi } from './ai-testing';
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

const put = (payload: object, lang = 'pt-BR') => app.inject({ method: 'PUT', url: `/api/ai/profile/${lang}`, payload });
const edited = (summary: string) => ({ ...SAMPLE_PROFILE, summary });

describe('PUT /ai/profile/:lang with the version the editor loaded', () => {
  it('saves when the profile is still at that version, and answers the new one', async () => {
    const loaded = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    const res = await put({ data: edited('Editado na tela.'), version: loaded.version });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ origin: 'editado', version: loaded.version + 1 });
  });

  it('answers 409 with a clear message, and changes nothing, when the server has a newer version', async () => {
    const loaded = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    // Enquanto o editor estava aberto com alterações, uma tradução (ou outra aba) gravou o perfil.
    const newer = await saveProfile(db, 'pt-BR', edited('Versão mais nova no servidor.'), 'traduzido');
    const res = await put({ data: edited('Rascunho antigo do editor.'), version: loaded.version });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'profile_conflict',
      message: 'O perfil mudou no servidor desde que você o abriu. Recarregue para ver a versão atual ou continue editando para gravar por cima dela.',
      currentVersion: newer.version,
    });
    expect(await profileFor(db, 'pt-BR')).toMatchObject({ version: newer.version, origin: 'traduzido' });
  });

  it('a version of the OTHER language does not count: versions are compared per profile', async () => {
    const pt = await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    await saveProfile(db, 'en', SAMPLE_PROFILE, 'traduzido');
    expect((await put({ data: edited('Ainda vale.'), version: pt.version })).statusCode).toBe(200);
  });

  it('without a version keeps the old behaviour (last writer wins), and rejects a version that is not a number', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    await saveProfile(db, 'pt-BR', edited('Mais nova.'), 'traduzido');
    expect((await put({ data: edited('Sem versão.') })).statusCode).toBe(200);
    expect((await put({ data: edited('x'), version: 'dois' })).statusCode).toBe(400);
    expect((await put({ data: edited('x'), version: 1 }, 'en')).statusCode).toBe(404);
  });
});
