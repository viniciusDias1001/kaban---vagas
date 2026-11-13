import { describe, expect, it } from 'vitest';
import { SettingsPatchSchema, type AiKeyMetaDto, type SettingsDto } from '@kv/shared';
import {
  OUTCOME_TONE, apiKeyProblem, changeProvider, collectCompanies, formFromSettings, isDirty, keyView, maskedKey, parseBudget,
  toSettingsPatch, validateSettings,
} from './settingsForm';

const key = (over: Partial<AiKeyMetaDto> = {}): AiKeyMetaDto => ({
  provider: 'openai', source: 'none', last4: null, savedAt: null, usable: false, problem: null, hasStored: false, ...over,
});

const dto: SettingsDto = {
  ai: {
    providers: ['anthropic', 'openai', 'gemini'],
    provider: { value: null, source: 'default' },
    modelFast: { value: null, source: 'default' },
    modelStrong: { value: null, source: 'default' },
    defaultModels: {
      anthropic: { fast: 'claude-haiku-5-5', strong: 'claude-opus-5-5' },
      openai: { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' },
      gemini: { fast: 'gemini-3.5-flash-lite', strong: 'gemini-4-carbon' },
    },
    dailyBudgetUsd: { value: 1, source: 'default' },
    tier1Enabled: { value: true, source: 'default' },
    tier2Auto: { value: true, source: 'default' },
    keys: [key({ provider: 'anthropic' }), key(), key({ provider: 'gemini' })],
    canStoreKeys: true, secretProblem: null, configured: false, problem: 'Nenhum provedor de IA escolhido.',
    budgetTimeZone: 'America/Sao_Paulo',
  },
  sources: {
    greenhouseBoards: { value: ['gitlab', 'stripe'], source: 'default' },
    leverCompanies: { value: ['spotify'], source: 'env' },
  },
  apply: {
    enabled: { value: false, source: 'default' }, minScore: { value: 70, source: 'default' },
    siteModes: { value: { linkedin: 'dry_run', greenhouse: 'dry_run', lever: 'dry_run', fake: 'dry_run' }, source: 'default' },
    dailyCaps: { value: { linkedin: 10, greenhouse: 15, lever: 15, fake: 15, total: 30, linkedinViews: 30 }, source: 'default' },
    companyCap: { value: 2, source: 'default' }, window: { value: { start: '08:00', end: '21:00' }, source: 'default' }, resumeMode: { value: 'tailored', source: 'default' },
    openAnswers: { value: true, source: 'default' }, blockedCompanies: { value: [], source: 'default' }, blockedTerms: { value: [], source: 'default' },
  },
  general: { nextRunAt: 0 },
};

describe('formFromSettings / toSettingsPatch', () => {
  it('an untouched form sends nothing, so values keep coming from the environment or the defaults', () => {
    const form = formFromSettings(dto);
    expect(form).toMatchObject({ provider: '', modelFast: '', dailyBudget: '1', greenhouseBoards: ['gitlab', 'stripe'] });
    expect(toSettingsPatch(form, dto)).toEqual({});
    expect(isDirty(form, dto)).toBe(false);
  });

  it('choosing a provider pre-fills its default models, and only what changed is sent', () => {
    const form = changeProvider(formFromSettings(dto), 'openai', dto);
    expect(form).toMatchObject({ provider: 'openai', modelFast: 'gpt-6-luna', modelStrong: 'gpt-6.1-sol' });
    expect(validateSettings(form)).toEqual({});
    const patch = toSettingsPatch({ ...form, dailyBudget: '2,5', tier1Enabled: false }, dto);
    expect(patch).toEqual({ provider: 'openai', modelFast: 'gpt-6-luna', modelStrong: 'gpt-6.1-sol', dailyBudgetUsd: 2.5, tier1Enabled: false });
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(true);
    expect(isDirty(form, dto)).toBe(true);
  });

  it('clearing the provider sends null, and the company draft counts when saving', () => {
    const configured: SettingsDto = { ...dto, ai: { ...dto.ai, provider: { value: 'openai', source: 'ui' }, modelFast: { value: 'gpt-6-luna', source: 'ui' }, modelStrong: { value: 'gpt-6.1-sol', source: 'default' } } };
    const form = { ...formFromSettings(configured), provider: '', modelFast: '', modelStrong: '', greenhouseDraft: ' Acme, gitlab ' };
    expect(validateSettings(form)).toEqual({});
    const patch = toSettingsPatch(form, configured);
    expect(patch).toEqual({ provider: null, modelFast: null, modelStrong: null, greenhouseBoards: ['gitlab', 'stripe', 'acme'] });
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(true);
  });
});

describe('validateSettings', () => {
  const base = changeProvider(formFromSettings(dto), 'anthropic', dto);

  it('requires the models once a provider is chosen, in the format of a model id', () => {
    expect(validateSettings({ ...base, modelFast: '' }).modelFast).toBe('Informe o modelo.');
    expect(validateSettings({ ...base, modelStrong: 'modelo com espaço' }).modelStrong).toMatch(/sem espaços/);
    expect(validateSettings({ ...base, modelFast: 'm'.repeat(81) }).modelFast).toMatch(/80 caracteres/);
    expect(validateSettings({ ...formFromSettings(dto) })).toEqual({});
  });

  it('accepts a budget from 0 to the cap, with comma or dot', () => {
    expect(['0', '1', '1,5', '2.25', '100'].map((dailyBudget) => validateSettings({ ...base, dailyBudget }).dailyBudget)).toEqual([
      undefined, undefined, undefined, undefined, undefined,
    ]);
    expect(validateSettings({ ...base, dailyBudget: '100,01' }).dailyBudget).toMatch(/máximo é US\$ 100/);
    for (const dailyBudget of ['', 'abc', '-1', '1,2,3', '1e3']) expect(validateSettings({ ...base, dailyBudget }).dailyBudget).toMatch(/valor em dólares/);
    expect([parseBudget(' 1,50 '), parseBudget('x')]).toEqual([1.5, null]);
  });

  it('checks the company lists: at least one, at most 30, names as in the url', () => {
    expect(validateSettings({ ...base, greenhouseBoards: [] }).greenhouseBoards).toBe('Informe ao menos uma empresa.');
    expect(validateSettings({ ...base, leverCompanies: Array.from({ length: 31 }, (_, i) => `e${i}`) }).leverCompanies).toMatch(/máximo 30/);
    expect(validateSettings({ ...base, leverCompanies: ['acme/../x'] }).leverCompanies).toMatch(/"acme\/\.\.\/x" não é um nome válido/);
    expect(collectCompanies(['GitLab', 'stripe'], 'Stripe figma,  acme')).toEqual(['gitlab', 'stripe', 'figma', 'acme']);
  });
});

describe('api key block', () => {
  it('chooses what to show for each state of a provider key', () => {
    expect(keyView(key({ source: 'env', usable: true }), true)).toBe('env');
    expect(keyView(key({ source: 'env', usable: true }), false)).toBe('env');
    expect(keyView(key({ source: 'stored', last4: '1234', usable: true, hasStored: true }), true)).toBe('stored');
    expect(keyView(key({ source: 'stored', last4: '1234', usable: false, problem: 'undecryptable', hasStored: true }), true)).toBe('undecryptable');
    expect(keyView(key({ source: 'stored', last4: '1234', usable: false, problem: 'no_secret', hasStored: true }), false)).toBe('locked');
    expect(keyView(key(), false)).toBe('locked');
    expect(keyView(key(), true)).toBe('empty');
  });

  it('shows a stored key only as its last four characters', () => {
    expect(maskedKey('Zx9Q')).toBe('•••• Zx9Q');
    expect(maskedKey(null)).toBe('••••');
  });

  it('checks a pasted key before sending', () => {
    expect(apiKeyProblem('  sk-test-abcdef123456\n')).toBeNull();
    expect(apiKeyProblem('')).toBe('Cole a chave de API.');
    expect(apiKeyProblem('curta')).toMatch(/curta/);
    expect(apiKeyProblem('sk com espaco 12345')).toMatch(/espaços/);
    expect(apiKeyProblem('x'.repeat(401))).toMatch(/longa/);
  });

  it('has a tone for every test-connection outcome', () => {
    expect(OUTCOME_TONE).toEqual({
      ok: 'ok', rate_limited: 'warn', network: 'warn', invalid_key: 'bad', model_not_found: 'bad', no_credit: 'bad', refused: 'bad', other: 'bad',
    });
  });
});
