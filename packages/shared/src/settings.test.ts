import { describe, expect, it } from 'vitest';
import { ApiKeyInputSchema, SETTING_SCHEMAS, SettingsPatchSchema } from './settings';
import { SETTING_KEYS, SETTINGS_LIMITS } from './settings-constants';

const ok = (patch: unknown) => SettingsPatchSchema.safeParse(patch).success;

describe('SettingsPatchSchema', () => {
  it('accepts any subset of fields, and null to clear a stored value', () => {
    expect(ok({})).toBe(true);
    expect(ok({ provider: 'openai', modelFast: 'gpt-6-luna', modelStrong: 'gpt-6.1-sol', dailyBudgetUsd: 2.5 })).toBe(true);
    expect(ok({ provider: null, modelFast: null, dailyBudgetUsd: null, tier1Enabled: null, greenhouseBoards: null })).toBe(true);
    expect(ok({ tier1Enabled: false, tier2Auto: true, leverCompanies: ['spotify'] })).toBe(true);
  });

  it('refuses unknown fields, so a key can never be smuggled in as a setting', () => {
    expect(ok({ apiKey: 'sk-segredo' })).toBe(false);
    expect(ok({ provider: 'openai', OPENAI_API_KEY: 'sk-segredo' })).toBe(false);
  });

  it('caps the budget, the model id and the company lists', () => {
    expect(ok({ dailyBudgetUsd: 0 })).toBe(true);
    expect(ok({ dailyBudgetUsd: SETTINGS_LIMITS.maxDailyBudgetUsd })).toBe(true);
    expect(ok({ dailyBudgetUsd: SETTINGS_LIMITS.maxDailyBudgetUsd + 0.01 })).toBe(false);
    expect(ok({ dailyBudgetUsd: -1 })).toBe(false);
    expect(ok({ dailyBudgetUsd: '1' })).toBe(false);
    expect(ok({ modelFast: 'm'.repeat(SETTINGS_LIMITS.modelId) })).toBe(true);
    expect(ok({ modelFast: 'm'.repeat(SETTINGS_LIMITS.modelId + 1) })).toBe(false);
    expect(ok({ modelFast: 'modelo com espaço' })).toBe(false);
    expect(ok({ modelFast: '' })).toBe(false);
    expect(ok({ provider: 'llama' })).toBe(false);
    expect(ok({ greenhouseBoards: [] })).toBe(false);
    expect(ok({ greenhouseBoards: Array.from({ length: SETTINGS_LIMITS.companies + 1 }, (_, i) => `e${i}`) })).toBe(false);
    expect(ok({ leverCompanies: ['../../etc/passwd'] })).toBe(false);
    expect(ok({ leverCompanies: ['acme?x=1'] })).toBe(false);
  });

  it('normalises company names: trimmed, lower case, no repeats', () => {
    expect(SettingsPatchSchema.parse({ greenhouseBoards: [' GitLab ', 'gitlab', 'stripe'] })).toEqual({
      greenhouseBoards: ['gitlab', 'stripe'],
    });
  });

  it('has one schema per setting key', () => {
    expect(Object.keys(SETTING_SCHEMAS).sort()).toEqual([...SETTING_KEYS].sort());
  });
});

describe('ApiKeyInputSchema', () => {
  it('trims the pasted key and refuses spaces, control characters, short and huge values', () => {
    expect(ApiKeyInputSchema.parse({ key: '  sk-test-abcdef123456\n' })).toEqual({ key: 'sk-test-abcdef123456' });
    for (const key of ['curta', 'sk com espaco 123', 'sk-\u0000nul-12345', 'x'.repeat(SETTINGS_LIMITS.apiKeyMax + 1), 'chave-ç-acentuada']) {
      expect(ApiKeyInputSchema.safeParse({ key }).success, key.slice(0, 20)).toBe(false);
    }
    expect(ApiKeyInputSchema.safeParse({ key: 'sk-test-abcdef123456', provider: 'openai' }).success).toBe(false);
  });
});
