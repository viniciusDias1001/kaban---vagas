import { z } from 'zod';
import { hasNul } from './constants';
import {
  AI_PROVIDER_IDS, API_KEY_PATTERN, COMPANY_SLUG_PATTERN, MODEL_ID_PATTERN, SETTINGS_LIMITS, type SettingKey,
  type SettingsPatch,
} from './settings-constants';

/** Validação das configurações gravadas pela tela. O navegador não importa este arquivo. */

const model = z.string().trim().min(1).max(SETTINGS_LIMITS.modelId).regex(MODEL_ID_PATTERN, 'identificador de modelo inválido');

const companies = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(SETTINGS_LIMITS.companySlug)
      .regex(COMPANY_SLUG_PATTERN, 'use o nome da empresa como aparece na URL (letras, dígitos, - e _)'),
  )
  .min(1, 'informe ao menos uma empresa')
  .max(SETTINGS_LIMITS.companies)
  .transform((list) => [...new Set(list)]);

/**
 * O schema de cada configuração. Usado duas vezes: para validar o PATCH e para reler o que está no banco
 * (uma linha que não passa aqui é ignorada, e vale o ambiente ou o padrão).
 */
export const SETTING_SCHEMAS = {
  provider: z.enum([...AI_PROVIDER_IDS, 'fake']),
  modelFast: model,
  modelStrong: model,
  dailyBudgetUsd: z.number().min(0).max(SETTINGS_LIMITS.maxDailyBudgetUsd),
  tier1Enabled: z.boolean(),
  tier2Auto: z.boolean(),
  greenhouseBoards: companies,
  leverCompanies: companies,
} satisfies Record<SettingKey, z.ZodType>;

/** PATCH /settings: todos os campos opcionais; `null` apaga o valor gravado; campo desconhecido é recusado. */
export const SettingsPatchSchema: z.ZodType<SettingsPatch> = z
  .strictObject({
    provider: SETTING_SCHEMAS.provider.nullable(),
    modelFast: SETTING_SCHEMAS.modelFast.nullable(),
    modelStrong: SETTING_SCHEMAS.modelStrong.nullable(),
    dailyBudgetUsd: SETTING_SCHEMAS.dailyBudgetUsd.nullable(),
    tier1Enabled: SETTING_SCHEMAS.tier1Enabled.nullable(),
    tier2Auto: SETTING_SCHEMAS.tier2Auto.nullable(),
    greenhouseBoards: SETTING_SCHEMAS.greenhouseBoards.nullable(),
    leverCompanies: SETTING_SCHEMAS.leverCompanies.nullable(),
  })
  .partial();

/** PUT /settings/ai-keys/:provider. A chave é aparada antes de validar (colar costuma trazer espaço ou quebra de linha). */
export const ApiKeyInputSchema = z.strictObject({
  key: z
    .string()
    .trim()
    .min(SETTINGS_LIMITS.apiKeyMin, 'chave curta demais')
    .max(SETTINGS_LIMITS.apiKeyMax, 'chave longa demais')
    .refine((s) => !hasNul(s) && API_KEY_PATTERN.test(s), 'a chave só pode ter caracteres visíveis, sem espaços'),
});

export const AiProviderIdSchema = z.enum(AI_PROVIDER_IDS);
