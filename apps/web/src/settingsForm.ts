import {
  API_KEY_PATTERN, APPLY_SETTINGS_LIMITS, APPLY_SITE_IDS, COMPANY_SLUG_PATTERN, MODEL_ID_PATTERN, SETTINGS_LIMITS, type AiKeyMetaDto,
  type ApplyAiAnswers, type ApplyDailyCaps, type EmailFactsMode, type EmailMoveMode, type PhoneAlertChannel, type ApplyMode, type ApplyResumeMode, type ApplySiteId, type SettingSource,
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
  applyEnabled: boolean;
  /** Texto do campo, como digitado. */
  applyMinScore: string;
  applySiteModes: Record<ApplySiteId, ApplyMode>;
  /** Texto de cada campo de limite diário. */
  applyDailyCaps: Record<keyof ApplyDailyCaps, string>;
  applyCompanyCap: string;
  /** 'HH:MM' */
  applyWindowStart: string;
  applyWindowEnd: string;
  applyResumeMode: ApplyResumeMode;
  applyAiAnswers: ApplyAiAnswers;
  applyBlockedCompanies: string[];
  /** Digitado e ainda não confirmado; conta junto ao salvar. */
  applyBlockedCompaniesDraft: string;
  applyBlockedTerms: string[];
  applyBlockedTermsDraft: string;
  /**
   * Sites em que o dono já confirmou a troca para "Enviar" nesta edição. Só da tela: nunca vai no PATCH e volta
   * vazio quando o formulário é descartado ou relido, então o aviso reaparece se o modo não foi salvo.
   */
  applyRealConfirmed: ApplySiteId[];
  emailEnabled: boolean;
  emailMoveMode: EmailMoveMode;
  emailFactsMode: EmailFactsMode;
  emailAiDrafts: boolean;
  /** O canal do aviso no celular. O token e o chat não estão aqui: têm botões próprios (o token nunca vira estado da tela). */
  phoneAlertChannel: PhoneAlertChannel;
}

export const APPLY_CAP_KEYS = ['linkedin', 'greenhouse', 'lever', 'fake', 'total', 'linkedinViews'] as const satisfies readonly (keyof ApplyDailyCaps)[];

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
    applyEnabled: dto.apply.enabled.value,
    applyMinScore: String(dto.apply.minScore.value),
    applySiteModes: { ...dto.apply.siteModes.value },
    applyDailyCaps: Object.fromEntries(APPLY_CAP_KEYS.map((k) => [k, String(dto.apply.dailyCaps.value[k])])) as Record<keyof ApplyDailyCaps, string>,
    applyCompanyCap: String(dto.apply.companyCap.value),
    applyWindowStart: dto.apply.window.value.start,
    applyWindowEnd: dto.apply.window.value.end,
    applyResumeMode: dto.apply.resumeMode.value,
    applyAiAnswers: dto.apply.aiAnswers.value,
    applyBlockedCompanies: [...dto.apply.blockedCompanies.value],
    applyBlockedCompaniesDraft: '',
    applyBlockedTerms: [...dto.apply.blockedTerms.value],
    applyBlockedTermsDraft: '',
    applyRealConfirmed: [],
    emailEnabled: dto.email.enabled.value,
    emailMoveMode: dto.email.moveMode.value,
    emailFactsMode: dto.email.factsMode.value,
    emailAiDrafts: dto.email.aiDrafts.value,
    phoneAlertChannel: dto.email.phoneAlertChannel.value,
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

/** Itens da lista de bloqueio: separados por vírgula ou quebra de linha (um termo pode ter espaços); sem vazios nem repetidos (sem diferenciar maiúsculas), na ordem. */
export function collectBlockItems(list: readonly string[], draft: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...list, ...draft.split(/[,\n]+/)]) {
    const item = raw.trim();
    if (item === '' || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
  }
  return out;
}

/** Inteiro sem sinal digitado ("70"); null quando não é. */
const parseWhole = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  applyMinScore?: string;
  applyDailyCaps?: string;
  applyCompanyCap?: string;
  applyWindow?: string;
  applyBlockedCompanies?: string;
  applyBlockedTerms?: string;
}

function blockListProblem(list: string[]): string | undefined {
  if (list.length > APPLY_SETTINGS_LIMITS.listItems) return `No máximo ${APPLY_SETTINGS_LIMITS.listItems} itens.`;
  if (list.some((i) => i.length > APPLY_SETTINGS_LIMITS.listItemLength)) return `Cada item pode ter no máximo ${APPLY_SETTINGS_LIMITS.listItemLength} caracteres.`;
  return undefined;
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

/** O primeiro limite diário inválido (é o campo que recebe o erro e o foco); undefined quando todos valem. */
export function badDailyCap(form: SettingsForm): keyof ApplyDailyCaps | undefined {
  return APPLY_CAP_KEYS.find((k) => {
    const n = parseWhole(form.applyDailyCaps[k]);
    return n === null || n > APPLY_SETTINGS_LIMITS.maxCap;
  });
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

  const score = parseWhole(form.applyMinScore);
  if (score === null || score > 100) errors.applyMinScore = 'Informe uma nota de 0 a 100.';
  if (badDailyCap(form)) errors.applyDailyCaps = `Cada limite diário vai de 0 a ${APPLY_SETTINGS_LIMITS.maxCap}.`;
  const companyCap = parseWhole(form.applyCompanyCap);
  if (companyCap === null || companyCap < 1 || companyCap > APPLY_SETTINGS_LIMITS.maxCompanyCap) {
    errors.applyCompanyCap = `Informe de 1 a ${APPLY_SETTINGS_LIMITS.maxCompanyCap} candidaturas por empresa.`;
  }
  if (!CLOCK.test(form.applyWindowStart) || !CLOCK.test(form.applyWindowEnd)) errors.applyWindow = 'Use o formato HH:MM.';
  else if (form.applyWindowStart >= form.applyWindowEnd) errors.applyWindow = 'O início precisa ser antes do fim.';
  const companies = blockListProblem(collectBlockItems(form.applyBlockedCompanies, form.applyBlockedCompaniesDraft));
  const terms = blockListProblem(collectBlockItems(form.applyBlockedTerms, form.applyBlockedTermsDraft));
  if (companies) errors.applyBlockedCompanies = companies;
  if (terms) errors.applyBlockedTerms = terms;
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
  addApplyChanges(form, dto, patch);
  addEmailChanges(form, dto, patch);
  return patch;
}

/** Os campos de candidatura que mudaram. Os mapas por site seguem parciais: a API mescla, então só vão os que mudaram. */
function addApplyChanges(form: SettingsForm, dto: SettingsDto, patch: SettingsPatch): void {
  const apply = dto.apply;
  if (form.applyEnabled !== apply.enabled.value) patch.applyEnabled = form.applyEnabled;
  const score = parseWhole(form.applyMinScore);
  if (score !== null && score !== apply.minScore.value) patch.applyMinScore = score;
  const modes: Partial<Record<ApplySiteId, ApplyMode>> = {};
  for (const site of APPLY_SITE_IDS) if (form.applySiteModes[site] !== apply.siteModes.value[site]) modes[site] = form.applySiteModes[site];
  if (Object.keys(modes).length > 0) patch.applySiteModes = modes;
  const caps: Partial<ApplyDailyCaps> = {};
  for (const key of APPLY_CAP_KEYS) {
    const n = parseWhole(form.applyDailyCaps[key]);
    if (n !== null && n !== apply.dailyCaps.value[key]) caps[key] = n;
  }
  if (Object.keys(caps).length > 0) patch.applyDailyCaps = caps;
  const companyCap = parseWhole(form.applyCompanyCap);
  if (companyCap !== null && companyCap !== apply.companyCap.value) patch.applyCompanyCap = companyCap;
  if (form.applyWindowStart !== apply.window.value.start || form.applyWindowEnd !== apply.window.value.end) {
    patch.applyWindow = { start: form.applyWindowStart, end: form.applyWindowEnd };
  }
  if (form.applyResumeMode !== apply.resumeMode.value) patch.applyResumeMode = form.applyResumeMode;
  if (form.applyAiAnswers !== apply.aiAnswers.value) patch.applyAiAnswers = form.applyAiAnswers;
  const companies = collectBlockItems(form.applyBlockedCompanies, form.applyBlockedCompaniesDraft);
  const terms = collectBlockItems(form.applyBlockedTerms, form.applyBlockedTermsDraft);
  if (!sameList(companies, apply.blockedCompanies.value)) patch.applyBlockedCompanies = companies;
  if (!sameList(terms, apply.blockedTerms.value)) patch.applyBlockedTerms = terms;
}

/** Os campos de e-mail que mudaram (duas chaves e três escolhas fechadas: sem erro de validação possível). */
function addEmailChanges(form: SettingsForm, dto: SettingsDto, patch: SettingsPatch): void {
  const email = dto.email;
  if (form.emailEnabled !== email.enabled.value) patch.emailEnabled = form.emailEnabled;
  if (form.emailMoveMode !== email.moveMode.value) patch.emailMoveMode = form.emailMoveMode;
  if (form.emailFactsMode !== email.factsMode.value) patch.emailFactsMode = form.emailFactsMode;
  if (form.emailAiDrafts !== email.aiDrafts.value) patch.emailAiDrafts = form.emailAiDrafts;
  if (form.phoneAlertChannel !== email.phoneAlertChannel.value) patch.phoneAlertChannel = form.phoneAlertChannel;
}

export const isDirty =(form: SettingsForm, dto: SettingsDto): boolean => Object.keys(toSettingsPatch(form, dto)).length > 0;

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
