import {
  API_KEY_PATTERN, COMPANY_SLUG_PATTERN, MODEL_ID_PATTERN, SETTINGS_LIMITS, type AiKeyMetaDto, type SettingSource,
  type SettingsDto, type SettingsPatch, type TestConnectionOutcome,
} from '@kv/shared/client';

/**
 * Estado e regras do formulário da aba Configurações, sem React (no estilo de `profileForm.ts`). A API
 * valida tudo de novo; aqui a validação serve para mostrar o erro junto do campo antes de enviar.
 */
export interface SettingsForm {
  /** '' = nenhum provedor escolhido. */
  provider: string;
  modelFast: string;
  modelStrong: string;
  /** Texto do campo de limite diário, como digitado ("1,50"). */
  dailyBudget: string;
  tier1Enabled: boolean;
  tier2Auto: boolean;
  greenhouseBoards: string[];
  /** Digitado no campo de empresas e ainda não transformado em tag; conta junto ao salvar. */
  greenhouseDraft: string;
  leverCompanies: string[];
  leverDraft: string;
}

const budgetText = (value: number) => String(value).replace('.', ',');

/** Formulário preenchido com as configurações em vigor. */
export function formFromSettings(dto: SettingsDto): SettingsForm {
  return {
    provider: dto.ai.provider.value ?? '',
    modelFast: dto.ai.modelFast.value ?? '',
    modelStrong: dto.ai.modelStrong.value ?? '',
    dailyBudget: budgetText(dto.ai.dailyBudgetUsd.value),
    tier1Enabled: dto.ai.tier1Enabled.value,
    tier2Auto: dto.ai.tier2Auto.value,
    greenhouseBoards: [...dto.sources.greenhouseBoards.value],
    greenhouseDraft: '',
    leverCompanies: [...dto.sources.leverCompanies.value],
    leverDraft: '',
  };
}

/** Trocar de provedor pré-preenche os dois modelos com os padrões dele. */
export function changeProvider(form: SettingsForm, provider: string, dto: SettingsDto): SettingsForm {
  const defaults = dto.ai.defaultModels[provider];
  return { ...form, provider, modelFast: defaults?.fast ?? '', modelStrong: defaults?.strong ?? '' };
}

/** Tags confirmadas + o que ainda estiver digitado, em minúsculas, sem vazias nem repetidas, na ordem. */
export function collectCompanies(list: readonly string[], draft: string): string[] {
  const all = [...list, ...draft.split(/[,\s]+/)].map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(all)];
}

/** "1,5" ou "1.5" → 1.5; null quando não é um número. */
export function parseBudget(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  return Number(normalized);
}

export interface SettingsFormErrors {
  modelFast?: string;
  modelStrong?: string;
  dailyBudget?: string;
  greenhouseBoards?: string;
  leverCompanies?: string;
}

function modelProblem(value: string, required: boolean): string | undefined {
  const model = value.trim();
  if (model === '') return required ? 'Informe o modelo.' : undefined;
  if (model.length > SETTINGS_LIMITS.modelId) return `No máximo ${SETTINGS_LIMITS.modelId} caracteres.`;
  if (!MODEL_ID_PATTERN.test(model)) return 'Use o identificador do modelo, sem espaços (ex.: claude-haiku-5-5).';
  return undefined;
}

function companiesProblem(list: string[]): string | undefined {
  if (list.length === 0) return 'Informe ao menos uma empresa.';
  if (list.length > SETTINGS_LIMITS.companies) return `No máximo ${SETTINGS_LIMITS.companies} empresas.`;
  const bad = list.find((c) => c.length > SETTINGS_LIMITS.companySlug || !COMPANY_SLUG_PATTERN.test(c));
  return bad ? `"${bad}" não é um nome válido: use o nome da empresa como aparece na URL (letras, dígitos, - e _).` : undefined;
}

/** Erros por campo; objeto vazio = pode salvar. */
export function validateSettings(form: SettingsForm): SettingsFormErrors {
  const errors: SettingsFormErrors = {};
  const hasProvider = form.provider !== '';
  const fast = modelProblem(form.modelFast, hasProvider);
  const strong = modelProblem(form.modelStrong, hasProvider);
  if (fast) errors.modelFast = fast;
  if (strong) errors.modelStrong = strong;
  const budget = parseBudget(form.dailyBudget);
  if (budget === null) errors.dailyBudget = 'Informe um valor em dólares, como 1,00.';
  else if (budget > SETTINGS_LIMITS.maxDailyBudgetUsd) errors.dailyBudget = `O limite máximo é US$ ${SETTINGS_LIMITS.maxDailyBudgetUsd}.`;
  const greenhouse = companiesProblem(collectCompanies(form.greenhouseBoards, form.greenhouseDraft));
  const lever = companiesProblem(collectCompanies(form.leverCompanies, form.leverDraft));
  if (greenhouse) errors.greenhouseBoards = greenhouse;
  if (lever) errors.leverCompanies = lever;
  return errors;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * O PATCH que leva o servidor do estado `dto` ao estado do formulário: só os campos que mudaram. Um
 * campo que o usuário não tocou não é enviado, então continua vindo do ambiente ou do padrão (e não
 * vira "gravado pela tela" à toa). Só chame com `validateSettings(form)` vazio.
 */
export function toSettingsPatch(form: SettingsForm, dto: SettingsDto): SettingsPatch {
  const patch: SettingsPatch = {};
  const provider = form.provider === '' ? null : form.provider;
  if (provider !== dto.ai.provider.value) patch.provider = provider as SettingsPatch['provider'];
  const fast = form.modelFast.trim() || null;
  const strong = form.modelStrong.trim() || null;
  if (fast !== dto.ai.modelFast.value) patch.modelFast = fast;
  if (strong !== dto.ai.modelStrong.value) patch.modelStrong = strong;
  const budget = parseBudget(form.dailyBudget);
  if (budget !== null && budget !== dto.ai.dailyBudgetUsd.value) patch.dailyBudgetUsd = budget;
  if (form.tier1Enabled !== dto.ai.tier1Enabled.value) patch.tier1Enabled = form.tier1Enabled;
  if (form.tier2Auto !== dto.ai.tier2Auto.value) patch.tier2Auto = form.tier2Auto;
  const greenhouse = collectCompanies(form.greenhouseBoards, form.greenhouseDraft);
  const lever = collectCompanies(form.leverCompanies, form.leverDraft);
  if (!sameList(greenhouse, dto.sources.greenhouseBoards.value)) patch.greenhouseBoards = greenhouse;
  if (!sameList(lever, dto.sources.leverCompanies.value)) patch.leverCompanies = lever;
  return patch;
}

export const isDirty = (form: SettingsForm, dto: SettingsDto): boolean => Object.keys(toSettingsPatch(form, dto)).length > 0;

/** Rótulo da origem de um valor. */
export const SOURCE_LABELS: Record<SettingSource, string> = {
  ui: 'definido aqui',
  env: 'do ambiente (.env)',
  default: 'padrão',
};

/** O que o bloco de chave de um provedor mostra. */
export type KeyView =
  /** Variável de ambiente definida: sem campo, só o aviso "definida pelo ambiente". */
  | 'env'
  /** Chave gravada e utilizável: "•••• 1234", data, trocar e remover. */
  | 'stored'
  /** Chave gravada que não decifra (APP_SECRET mudou): pede a chave de novo. */
  | 'undecryptable'
  /** Sem APP_SECRET: campo desabilitado, com a instrução de como gerar o segredo. */
  | 'locked'
  /** Nenhuma chave: campo para digitar. */
  | 'empty';

export function keyView(meta: AiKeyMetaDto, canStoreKeys: boolean): KeyView {
  if (meta.source === 'env') return 'env';
  if (!canStoreKeys) return 'locked';
  if (meta.source === 'stored') return meta.usable ? 'stored' : 'undecryptable';
  return 'empty';
}

/** "•••• 1234": a única forma em que uma chave gravada aparece na tela. */
export const maskedKey = (last4: string | null): string => (last4 ? `•••• ${last4}` : '••••');

/** Confere a chave antes de enviar; devolve a mensagem de erro ou null. */
export function apiKeyProblem(text: string): string | null {
  const key = text.trim();
  if (key === '') return 'Cole a chave de API.';
  if (key.length < SETTINGS_LIMITS.apiKeyMin) return 'A chave parece curta demais.';
  if (key.length > SETTINGS_LIMITS.apiKeyMax) return 'A chave é longa demais.';
  if (!API_KEY_PATTERN.test(key)) return 'A chave não pode ter espaços nem caracteres especiais.';
  return null;
}

/** Aparência do resultado do "Testar conexão". */
export const OUTCOME_TONE: Record<TestConnectionOutcome, 'ok' | 'warn' | 'bad'> = {
  ok: 'ok',
  rate_limited: 'warn',
  network: 'warn',
  invalid_key: 'bad',
  model_not_found: 'bad',
  no_credit: 'bad',
  refused: 'bad',
  other: 'bad',
};
