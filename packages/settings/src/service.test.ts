import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { aiKeys, closeDb, settings, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { SecretMissingError } from './secret-box';
import { EnvKeyError, SettingsValidationError, createSettingsService } from './service';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-0001';
const KEY = 'sk-test-chave-ficticia-ABCD';

let db: Db;
let clock: number;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  clock = 1_000_000;
});
afterAll(() => closeDb(db));

const service = (env: Record<string, string | undefined> = {}, ttlMs = 5_000) =>
  createSettingsService(db, { env, now: () => clock, ttlMs });

describe('precedence: screen > environment > code default', () => {
  it('uses the code defaults when nothing is set', async () => {
    const s = await service().get();
    expect(s).toEqual({
      provider: { value: null, source: 'default' },
      modelFast: { value: null, source: 'default' },
      modelStrong: { value: null, source: 'default' },
      dailyBudgetUsd: { value: 1, source: 'default' },
      tier1Enabled: { value: true, source: 'default' },
      tier2Auto: { value: true, source: 'default' },
      greenhouseBoards: { value: ['gitlab', 'stripe', 'cloudflare', 'figma'], source: 'default' },
      leverCompanies: { value: ['palantir', 'spotify'], source: 'default' },
      budgetTimeZone: 'America/Sao_Paulo',
    });
  });

  it('takes the environment as the starting value, and the provider default models', async () => {
    const s = await service({
      AI_PROVIDER: 'OpenAI', AI_MODEL_STRONG: 'gpt-6-astra', AI_DAILY_BUDGET_USD: '2.5', GREENHOUSE_BOARDS: 'Acme, beta', AI_BUDGET_TZ: 'UTC',
    }).get();
    expect(s.provider).toEqual({ value: 'openai', source: 'env' });
    expect(s.modelFast).toEqual({ value: 'gpt-6-luna', source: 'default' });
    expect(s.modelStrong).toEqual({ value: 'gpt-6-astra', source: 'env' });
    expect(s.dailyBudgetUsd).toEqual({ value: 2.5, source: 'env' });
    expect(s.greenhouseBoards).toEqual({ value: ['acme', 'beta'], source: 'env' });
    expect(s.leverCompanies.source).toBe('default');
    expect(s.budgetTimeZone).toBe('UTC');
  });

  it('lets a value saved on the screen win over the environment, and null gives the environment back', async () => {
    const svc = service({ AI_PROVIDER: 'openai', AI_DAILY_BUDGET_USD: '2.5', LEVER_COMPANIES: 'acme' });
    const saved = await svc.update({
      provider: 'anthropic', modelFast: 'claude-haiku-5-5', dailyBudgetUsd: 0.5, tier1Enabled: false, leverCompanies: ['spotify', 'figma'],
    });
    expect(saved.provider).toEqual({ value: 'anthropic', source: 'ui' });
    expect(saved.modelFast).toEqual({ value: 'claude-haiku-5-5', source: 'ui' });
    expect(saved.modelStrong).toEqual({ value: 'claude-opus-5-5', source: 'default' });
    expect(saved.dailyBudgetUsd).toEqual({ value: 0.5, source: 'ui' });
    expect(saved.tier1Enabled).toEqual({ value: false, source: 'ui' });
    expect(saved.leverCompanies).toEqual({ value: ['spotify', 'figma'], source: 'ui' });
    expect(await svc.connectorConfig()).toEqual({ greenhouseBoards: ['gitlab', 'stripe', 'cloudflare', 'figma'], leverCompanies: ['spotify', 'figma'] });

    const cleared = await svc.update({ provider: null, dailyBudgetUsd: null, leverCompanies: null });
    expect(cleared.provider).toEqual({ value: 'openai', source: 'env' });
    expect(cleared.dailyBudgetUsd).toEqual({ value: 2.5, source: 'env' });
    expect(cleared.leverCompanies).toEqual({ value: ['acme'], source: 'env' });
    expect((await db.select().from(settings)).map((r) => r.key).sort()).toEqual(['modelFast', 'tier1Enabled']);
  });

  it('ignores a stored row that no longer passes validation and unknown keys', async () => {
    await db.insert(settings).values([
      { key: 'dailyBudgetUsd', value: 1_000_000, updatedAt: 1 },
      { key: 'provider', value: 'llama', updatedAt: 1 },
      { key: 'greenhouseBoards', value: ['../etc'], updatedAt: 1 },
      { key: 'desconhecida', value: true, updatedAt: 1 },
    ]);
    const s = await service({ AI_PROVIDER: 'gemini' }).get();
    expect(s.dailyBudgetUsd).toEqual({ value: 1, source: 'default' });
    expect(s.provider).toEqual({ value: 'gemini', source: 'env' });
    expect(s.greenhouseBoards.source).toBe('default');
  });

  it('ignores an invalid environment value', async () => {
    const s = await service({ AI_PROVIDER: 'llama', AI_DAILY_BUDGET_USD: 'abc', AI_BUDGET_TZ: 'Marte/Olimpo', GREENHOUSE_BOARDS: ' , ' }).get();
    expect(s.provider.value).toBeNull();
    expect(s.dailyBudgetUsd).toEqual({ value: 1, source: 'default' });
    expect(s.budgetTimeZone).toBe('America/Sao_Paulo');
    expect(s.greenhouseBoards.source).toBe('default');
  });

  it('offers the fake provider only in test mode', async () => {
    await expect(service().update({ provider: 'fake' })).rejects.toBeInstanceOf(SettingsValidationError);
    const svc = service({ AI_ALLOW_FAKE: '1' });
    expect((await svc.update({ provider: 'fake' })).provider).toEqual({ value: 'fake', source: 'ui' });
    expect((await svc.status())).toMatchObject({ configured: true, provider: 'fake', models: { fast: 'fake-fast', strong: 'fake-strong' } });
    // O mesmo banco, lido por um processo sem o modo de teste: o valor gravado é ignorado.
    expect((await service().get()).provider.value).toBeNull();
  });
});

describe('cache', () => {
  it('reads the database at most once per TTL, and again after it expires', async () => {
    const svc = service({}, 5_000);
    expect((await svc.get()).dailyBudgetUsd.value).toBe(1);
    // Outro processo (a API, vista pelo worker) grava direto no banco.
    await db.insert(settings).values({ key: 'dailyBudgetUsd', value: 7, updatedAt: 1 });
    clock += 4_999;
    expect((await svc.get()).dailyBudgetUsd.value).toBe(1);
    clock += 1;
    expect((await svc.get()).dailyBudgetUsd.value).toBe(7);
  });

  it('is invalidated at once by a write made through the service, and by invalidate()', async () => {
    const svc = service();
    await svc.get();
    expect((await svc.update({ dailyBudgetUsd: 3 })).dailyBudgetUsd.value).toBe(3);
    expect((await svc.get()).dailyBudgetUsd.value).toBe(3);
    await db.update(settings).set({ value: 9 }).where(eq(settings.key, 'dailyBudgetUsd'));
    expect((await svc.get()).dailyBudgetUsd.value).toBe(3);
    svc.invalidate();
    expect((await svc.get()).dailyBudgetUsd.value).toBe(9);
  });
});

describe('api keys', () => {
  it('stores a key encrypted and exposes only provider, last four characters and when it was saved', async () => {
    const svc = service({ APP_SECRET: SECRET });
    const meta = await svc.saveKey('openai', KEY);
    expect(meta).toEqual({ provider: 'openai', source: 'stored', last4: 'ABCD', savedAt: clock, usable: true, problem: null, hasStored: true });
    const [row] = await db.select().from(aiKeys);
    expect(row.last4).toBe('ABCD');
    expect(Buffer.from(row.sealed).toString('latin1')).not.toContain(KEY);
    expect(JSON.stringify(await svc.keys())).not.toContain(KEY);
    expect(JSON.stringify(await svc.dto(0))).not.toContain(KEY);
    expect(JSON.stringify(await svc.status())).not.toContain(KEY);
    expect((await svc.keys()).map((k) => k.source)).toEqual(['none', 'stored', 'none']);
  });

  it('keeps one key per provider: changing the provider does not erase the others, and a new key replaces the old', async () => {
    const svc = service({ APP_SECRET: SECRET });
    await svc.saveKey('openai', KEY);
    await svc.saveKey('anthropic', 'sk-ant-ficticia-WXYZ');
    await svc.update({ provider: 'anthropic' });
    expect((await svc.aiConfig()).config).toMatchObject({ provider: 'anthropic', apiKey: 'sk-ant-ficticia-WXYZ' });
    await svc.update({ provider: 'openai' });
    expect((await svc.aiConfig()).config).toMatchObject({ provider: 'openai', apiKey: KEY, models: { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' } });
    clock += 10;
    expect(await svc.saveKey('openai', 'sk-test-outra-chave-9999')).toMatchObject({ last4: '9999', savedAt: clock });
    expect(await db.select().from(aiKeys)).toHaveLength(2);
    await svc.deleteKey('openai');
    expect((await svc.aiConfig())).toEqual({ config: null, problem: expect.stringContaining('Falta a chave de API de OpenAI') });
    expect((await svc.keys()).map((k) => k.source)).toEqual(['stored', 'none', 'none']);
  });

  it('prefers the key of the environment, says so, and refuses to overwrite it', async () => {
    const svc = service({ APP_SECRET: SECRET, AI_PROVIDER: 'openai', OPENAI_API_KEY: ' sk-env-do-ambiente-0000 ' });
    await expect(svc.saveKey('openai', KEY)).rejects.toBeInstanceOf(EnvKeyError);
    expect(await db.select().from(aiKeys)).toHaveLength(0);
    expect((await svc.aiConfig()).config?.apiKey).toBe('sk-env-do-ambiente-0000');
    const [, openai] = await svc.keys();
    // Nem os últimos caracteres da chave do ambiente são expostos.
    expect(openai).toEqual({ provider: 'openai', source: 'env', last4: null, savedAt: null, usable: true, problem: null, hasStored: false });
    expect(JSON.stringify(await svc.dto(0))).not.toContain('0000');
    // Os outros provedores continuam editáveis.
    await expect(svc.saveKey('gemini', 'AIza-ficticia-1234')).resolves.toMatchObject({ source: 'stored' });
  });

  it('without APP_SECRET refuses to store a key, and everything else keeps working', async () => {
    const svc = service({});
    await expect(svc.saveKey('openai', KEY)).rejects.toBeInstanceOf(SecretMissingError);
    expect(await db.select().from(aiKeys)).toHaveLength(0);
    expect(svc.secretProblem()).toMatch(/APP_SECRET não está definida/);
    expect((await svc.update({ dailyBudgetUsd: 2 })).dailyBudgetUsd.value).toBe(2);
    const dto = await svc.dto(0);
    expect(dto.ai).toMatchObject({ canStoreKeys: false, secretProblem: expect.stringContaining('randomBytes(32)') });
  });

  it('handles a rotated APP_SECRET gracefully: the stored key is reported as undecryptable and can be saved again', async () => {
    await service({ APP_SECRET: SECRET }).saveKey('openai', KEY);
    await service({ APP_SECRET: SECRET }).update({ provider: 'openai' });
    const rotated = service({ APP_SECRET: 'um-segredo-novo-com-mais-de-32-caracteres-xyz' });
    const result = await rotated.aiConfig();
    expect(result.config).toBeNull();
    expect(result.problem).toMatch(/não pôde ser decifrada.*Grave a chave de novo/);
    expect(result.problem).not.toContain(KEY);
    expect((await rotated.keys())[1]).toMatchObject({ source: 'stored', last4: 'ABCD', usable: false, problem: 'undecryptable' });
    expect(await rotated.status()).toMatchObject({ configured: false, provider: 'openai' });
    await rotated.saveKey('openai', KEY);
    expect((await rotated.aiConfig()).config?.apiKey).toBe(KEY);

    const missing = service({});
    expect((await missing.keys())[1]).toMatchObject({ usable: false, problem: 'no_secret' });
    expect((await missing.aiConfig()).problem).toMatch(/não pode ser lida.*APP_SECRET/);
  });

  it('a sealed key copied to another provider row does not open', async () => {
    const svc = service({ APP_SECRET: SECRET });
    await svc.saveKey('openai', KEY);
    const [row] = await db.select().from(aiKeys);
    await db.insert(aiKeys).values({ provider: 'anthropic', sealed: row.sealed, last4: row.last4, updatedAt: 1 });
    svc.invalidate();
    expect((await svc.keys())[0]).toMatchObject({ provider: 'anthropic', usable: false, problem: 'undecryptable' });
    await svc.update({ provider: 'anthropic' });
    expect((await svc.aiConfig()).config).toBeNull();
  });

  it('never keeps a decrypted key in the cache: each aiConfig() decrypts again', async () => {
    const svc = service({ APP_SECRET: SECRET });
    await svc.saveKey('openai', KEY);
    await svc.update({ provider: 'openai' });
    expect((await svc.aiConfig()).config?.apiKey).toBe(KEY);
    // Dentro do TTL (o cache não foi invalidado), o conteúdo cifrado é trocado no banco e o cache é
    // descartado só para as linhas: se a chave em claro estivesse guardada, ela continuaria saindo.
    await db.update(aiKeys).set({ sealed: Buffer.from('lixo-que-nao-decifra-000000000000000000') });
    svc.invalidate();
    expect((await svc.aiConfig()).config).toBeNull();
  });

  it('builds the config for one provider at a time for the smoke script, with that provider default models', async () => {
    const svc = service({ APP_SECRET: SECRET, AI_PROVIDER: 'openai', GEMINI_API_KEY: 'g-env' });
    await svc.saveKey('anthropic', 'sk-ant-ficticia-WXYZ');
    expect((await svc.aiConfig('anthropic')).config).toMatchObject({ provider: 'anthropic', apiKey: 'sk-ant-ficticia-WXYZ', models: { fast: 'claude-haiku-5-5' } });
    expect((await svc.aiConfig('gemini')).config).toMatchObject({ provider: 'gemini', apiKey: 'g-env' });
    expect((await svc.aiConfig('openai')).config).toBeNull();
  });
});

describe('dto', () => {
  it('lists providers, default models, sources and the next run, with no secret', async () => {
    const svc = service({ APP_SECRET: SECRET, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-env-7777' });
    const dto = await svc.dto(123);
    expect(dto.ai.providers).toEqual(['anthropic', 'openai', 'gemini']);
    expect(dto.ai.defaultModels.openai).toEqual({ fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' });
    expect(dto.ai).toMatchObject({ configured: true, problem: null, canStoreKeys: true, secretProblem: null, budgetTimeZone: 'America/Sao_Paulo' });
    expect(dto.ai.modelFast).toEqual({ value: 'claude-haiku-5-5', source: 'default' });
    expect(dto.general).toEqual({ nextRunAt: 123 });
    expect(JSON.stringify(dto)).not.toMatch(/sk-ant-env-7777|7777/);
    expect((await service({ AI_ALLOW_FAKE: '1' }).dto(0)).ai.providers).toContain('fake');
  });
});
