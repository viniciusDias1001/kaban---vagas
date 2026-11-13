import { describe, expect, it } from 'vitest';
import { SettingsPatchSchema, type AiKeyMetaDto, type SettingsDto } from '@kv/shared';
import {
  OUTCOME_TONE, apiKeyProblem, badDailyCap, changeProvider, collectBlockItems, collectCompanies, formFromSettings, isDirty, keyView, maskedKey, parseBudget,
  toSettingsPatch, validateSettings, type SettingsForm,
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
    aiAnswers: { value: 'review', source: 'default' }, blockedCompanies: { value: [], source: 'default' }, blockedTerms: { value: [], source: 'default' },
  },
  email: {
    enabled: { value: true, source: 'default' }, moveMode: { value: 'auto', source: 'default' },
    factsMode: { value: 'auto', source: 'default' }, aiDrafts: { value: true, source: 'default' },
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

describe('apply settings', () => {
  it('sends only the apply settings that changed', () => {
    const form = formFromSettings(dto);
    expect(form).toMatchObject({ applyEnabled: false, applyMinScore: '70', applyWindowStart: '08:00', applyAiAnswers: 'review', applyDailyCaps: { total: '30' } });
    expect(toSettingsPatch(form, dto)).toEqual({});
    expect(toSettingsPatch({ ...form, applyMinScore: '75' }, dto)).toEqual({ applyMinScore: 75 });
    expect(toSettingsPatch({ ...form, applyEnabled: true, applyAiAnswers: 'auto', applyResumeMode: 'base', applyCompanyCap: '3' }, dto))
      .toEqual({ applyEnabled: true, applyAiAnswers: 'auto', applyResumeMode: 'base', applyCompanyCap: 3 });
  });

  it('sends only the sites and the caps that changed, and the window as a whole', () => {
    const form = formFromSettings(dto);
    const patch = toSettingsPatch({
      ...form, applySiteModes: { ...form.applySiteModes, greenhouse: 'real' },
      applyDailyCaps: { ...form.applyDailyCaps, linkedin: '5', total: '40' }, applyWindowEnd: '20:00',
    }, dto);
    expect(patch).toEqual({ applySiteModes: { greenhouse: 'real' }, applyDailyCaps: { linkedin: 5, total: 40 }, applyWindow: { start: '08:00', end: '20:00' } });
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('collects block lists, keeping spaces inside a term and counting the draft', () => {
    const form = { ...formFromSettings(dto), applyBlockedCompanies: ['Acme'], applyBlockedCompaniesDraft: 'acme, Globex\nInitech ', applyBlockedTermsDraft: 'vaga presencial' };
    expect(collectBlockItems(form.applyBlockedCompanies, form.applyBlockedCompaniesDraft)).toEqual(['Acme', 'Globex', 'Initech']);
    const patch = toSettingsPatch(form, dto);
    expect(patch).toEqual({ applyBlockedCompanies: ['Acme', 'Globex', 'Initech'], applyBlockedTerms: ['vaga presencial'] });
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('refuses a minimum score above 100 and a window that ends before it starts', () => {
    const form = formFromSettings(dto);
    expect(validateSettings(form)).toEqual({});
    const errors = validateSettings({ ...form, applyMinScore: '101', applyWindowStart: '21:00', applyWindowEnd: '08:00' });
    expect(Object.keys(errors).sort()).toEqual(['applyMinScore', 'applyWindow']);
    expect(validateSettings({ ...form, applyMinScore: 'abc' }).applyMinScore).toBeDefined();
    expect(validateSettings({ ...form, applyWindowEnd: '8h' }).applyWindow).toBeDefined();
  });

  it('refuses caps outside the limits, with a smaller maximum for the per-company cap', () => {
    const form = formFromSettings(dto);
    expect(validateSettings({ ...form, applyDailyCaps: { ...form.applyDailyCaps, lever: '201' } }).applyDailyCaps).toBeDefined();
    expect(validateSettings({ ...form, applyDailyCaps: { ...form.applyDailyCaps, lever: '0' } })).toEqual({});
    expect(validateSettings({ ...form, applyCompanyCap: '21' }).applyCompanyCap).toBeDefined();
    expect(validateSettings({ ...form, applyCompanyCap: '0' }).applyCompanyCap).toBeDefined();
    expect(validateSettings({ ...form, applyBlockedTermsDraft: 'x'.repeat(81) }).applyBlockedTerms).toBeDefined();
  });

  it('names the first invalid daily cap, the same one validateSettings rejects', () => {
    const form = formFromSettings(dto);
    const caps = (over: Partial<SettingsForm['applyDailyCaps']>) => ({ ...form, applyDailyCaps: { ...form.applyDailyCaps, ...over } });
    // Todos válidos: nenhum campo e nenhum erro.
    expect(badDailyCap(form)).toBeUndefined();
    expect(validateSettings(form).applyDailyCaps).toBeUndefined();
    // Vazio.
    expect(badDailyCap(caps({ fake: '' }))).toBe('fake');
    // Acima do máximo.
    expect(badDailyCap(caps({ linkedinViews: '201' }))).toBe('linkedinViews');
    expect(badDailyCap(caps({ total: '200' }))).toBeUndefined();
    // Vários inválidos: o primeiro na ordem da tela (sites, depois total e vagas abertas).
    expect(badDailyCap(caps({ lever: '201', total: '', linkedin: '1,5' }))).toBe('linkedin');
    // O erro existe exatamente quando há um campo para receber o foco.
    for (const over of [{ fake: '' }, { linkedinViews: '201' }, { total: '200' }, { lever: 'x' }, {}]) {
      const f = caps(over);
      expect(validateSettings(f).applyDailyCaps !== undefined).toBe(badDailyCap(f) !== undefined);
    }
  });

  it('keeps the one-time "Enviar" confirmation in the form only: never sent, reset with the form', () => {
    const form = formFromSettings(dto);
    expect(form.applyRealConfirmed).toEqual([]);
    const confirmed = { ...form, applyRealConfirmed: ['fake' as const] };
    expect(toSettingsPatch(confirmed, dto)).toEqual({});
    expect(isDirty(confirmed, dto)).toBe(false);
  });
});
