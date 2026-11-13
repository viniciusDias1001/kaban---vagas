/**
 * Configurações (aba Configurações): constantes, tipos e DTOs, sem Zod (vão para o navegador por
 * `@kv/shared/client`). A validação fica em `settings.ts`.
 */

import type { ApplyMode, ApplyResumeMode, ApplySiteId } from './apply-constants';

export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'gemini'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const AI_PROVIDER_LABELS: Record<AiProviderId | 'fake', string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI',
  gemini: 'Gemini (Google)',
  fake: 'Provedor falso (testes)',
};

/** Variável de ambiente da chave de cada provedor. Definida, ela tem prioridade sobre a chave gravada pela tela. */
export const AI_KEY_ENV_VARS: Record<AiProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/** Padrões de código das listas de empresas (os mesmos que os conectores usavam). */
export const DEFAULT_GREENHOUSE_BOARDS: readonly string[] = ['gitlab', 'stripe', 'cloudflare', 'figma'];
export const DEFAULT_LEVER_COMPANIES: readonly string[] = ['palantir', 'spotify'];

/** Tetos das configurações gravadas pela tela (a API responde 400 fora deles). */
export const SETTINGS_LIMITS = {
  modelId: 80,
  /** Teto do limite diário de gasto, em US$. */
  maxDailyBudgetUsd: 100,
  /** Empresas por lista (Greenhouse, Lever): cada uma é uma requisição por busca. */
  companies: 30,
  companySlug: 60,
  apiKeyMin: 8,
  apiKeyMax: 400,
} as const;

/** Identificador de modelo: letras, dígitos e `. _ : / -`, começando por letra ou dígito. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/** Nome de board/empresa como aparece na URL do Greenhouse e do Lever. */
export const COMPANY_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
/** Chave de API: ASCII visível, sem espaços. */
export const API_KEY_PATTERN = /^[\x21-\x7e]+$/;

/** Mínimo de caracteres de APP_SECRET (um segredo gerado por máquina; ver `.env.example`). */
export const APP_SECRET_MIN_LENGTH = 32;
export const APP_SECRET_COMMAND = `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`;

/** Campos que a tela pode gravar. `null` em um campo do PATCH apaga o valor gravado (volta ao ambiente/padrão). */
export const SETTING_KEYS = [
  'provider', 'modelFast', 'modelStrong', 'dailyBudgetUsd', 'tier1Enabled', 'tier2Auto', 'greenhouseBoards', 'leverCompanies',
  'applyEnabled', 'applyMinScore', 'applySiteModes', 'applyDailyCaps', 'applyCompanyCap', 'applyWindow', 'applyResumeMode',
  'applyOpenAnswers', 'applyBlockedCompanies', 'applyBlockedTerms',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** De onde veio o valor em vigor: gravado pela tela, variável de ambiente ou padrão do código. */
export type SettingSource = 'ui' | 'env' | 'default';
export interface SettingValue<T> {
  value: T;
  source: SettingSource;
}

/** Limites das configurações de candidatura automática. */
export const APPLY_SETTINGS_LIMITS = { maxCap: 200, maxCompanyCap: 20, listItems: 100, listItemLength: 80 } as const;

export interface ApplyDailyCaps { linkedin: number; greenhouse: number; lever: number; fake: number; total: number; linkedinViews: number }
export interface ApplyWindow { start: string; end: string } // 'HH:MM'
/** As configurações de candidatura em vigor, como API e worker as leem. */
export interface ApplyConfig {
  enabled: boolean; minScore: number; siteModes: Record<ApplySiteId, ApplyMode>; dailyCaps: ApplyDailyCaps;
  companyCap: number; window: ApplyWindow; resumeMode: ApplyResumeMode; openAnswers: boolean;
  blockedCompanies: string[]; blockedTerms: string[];
  /** O fuso do "dia" e do horário: o mesmo de AI_BUDGET_TZ. */
  timeZone: string;
}

export interface AiKeyMetaDto {
  provider: AiProviderId;
  /** `env`: definida pelo ambiente (não editável pela tela); `stored`: gravada cifrada no banco; `none`: não há. */
  source: 'env' | 'stored' | 'none';
  /** Só os quatro últimos caracteres. A chave inteira nunca sai do servidor. */
  last4: string | null;
  /** Quando a chave gravada foi salva; null para `env` e `none`. */
  savedAt: number | null;
  /** A chave pode ser usada agora. false = gravada, mas não decifra (APP_SECRET mudou ou falta). */
  usable: boolean;
  problem: 'undecryptable' | 'no_secret' | null;
  /** Existe uma chave gravada no banco (mesmo que a do ambiente esteja em uso). */
  hasStored: boolean;
}

export interface SettingsDto {
  ai: {
    /** Provedores que podem ser escolhidos (`fake` só aparece em modo de teste). */
    providers: string[];
    provider: SettingValue<string | null>;
    modelFast: SettingValue<string | null>;
    modelStrong: SettingValue<string | null>;
    /** Modelos padrão de cada provedor, para pré-preencher ao trocar de provedor. */
    defaultModels: Record<string, { fast: string; strong: string }>;
    dailyBudgetUsd: SettingValue<number>;
    /** Triagem automática das vagas novas (camada 1). */
    tier1Enabled: SettingValue<boolean>;
    /** Análise automática ao abrir a vaga ou movê-la para Selecionadas (camada 2). */
    tier2Auto: SettingValue<boolean>;
    keys: AiKeyMetaDto[];
    /** APP_SECRET está definida e é longa o bastante: dá para gravar chave pela tela. */
    canStoreKeys: boolean;
    /** Por que não dá (texto para a tela); null quando dá. */
    secretProblem: string | null;
    configured: boolean;
    problem: string | null;
    budgetTimeZone: string;
  };
  sources: {
    greenhouseBoards: SettingValue<string[]>;
    leverCompanies: SettingValue<string[]>;
  };
  apply: {
    enabled: SettingValue<boolean>;
    minScore: SettingValue<number>;
    siteModes: SettingValue<Record<ApplySiteId, ApplyMode>>;
    dailyCaps: SettingValue<ApplyDailyCaps>;
    companyCap: SettingValue<number>;
    window: SettingValue<ApplyWindow>;
    resumeMode: SettingValue<ApplyResumeMode>;
    openAnswers: SettingValue<boolean>;
    blockedCompanies: SettingValue<string[]>;
    blockedTerms: SettingValue<string[]>;
  };
  general: {
    /** Próxima busca horária (hora cheia). O estado do worker vem de GET /runs/health. */
    nextRunAt: number;
  };
}

/** O corpo do PATCH /settings (os tipos; a validação é `SettingsPatchSchema`). */
export interface SettingsPatch {
  provider?: AiProviderId | 'fake' | null;
  modelFast?: string | null;
  modelStrong?: string | null;
  dailyBudgetUsd?: number | null;
  tier1Enabled?: boolean | null;
  tier2Auto?: boolean | null;
  greenhouseBoards?: string[] | null;
  leverCompanies?: string[] | null;
  applyEnabled?: boolean | null;
  applyMinScore?: number | null;
  /** Parcial: o que faltar vale o padrão (`dry_run`). */
  applySiteModes?: Partial<Record<ApplySiteId, ApplyMode>> | null;
  /** Parcial: o que faltar vale o padrão. */
  applyDailyCaps?: Partial<ApplyDailyCaps> | null;
  applyCompanyCap?: number | null;
  applyWindow?: ApplyWindow | null;
  applyResumeMode?: ApplyResumeMode | null;
  applyOpenAnswers?: boolean | null;
  applyBlockedCompanies?: string[] | null;
  applyBlockedTerms?: string[] | null;
}

export type TestConnectionOutcome =
  | 'ok' | 'invalid_key' | 'model_not_found' | 'no_credit' | 'rate_limited' | 'network' | 'refused' | 'other';

export interface TestConnectionDto {
  outcome: TestConnectionOutcome;
  /** Frase pronta para a tela. Nunca contém a chave. */
  message: string;
  provider: string;
  model: string | null;
  latencyMs: number | null;
}
