import { eq } from 'drizzle-orm';
import {
  DEFAULT_BUDGET_TIME_ZONE, DEFAULT_DAILY_BUDGET_USD, DEFAULT_MODELS, resolveAiConfig, type AiConfigResult,
} from '@kv/ai';
import { aiKeys, settings as settingsTable, type Db } from '@kv/db';
import {
  APPLY_DEFAULTS, APPLY_SITE_IDS, type ApplyConfig, type ApplyDailyCaps, type ApplyMode, type ApplyResumeMode,
  type ApplySiteId, type ApplyWindow,
  AI_KEY_ENV_VARS, AI_PROVIDER_IDS, AI_PROVIDER_LABELS, DEFAULT_GREENHOUSE_BOARDS, DEFAULT_LEVER_COMPANIES, SETTING_KEYS,
  SETTING_SCHEMAS, type AiKeyMetaDto, type AiProviderId, type SettingKey, type SettingSource, type SettingValue,
  type SettingsDto, type SettingsPatch,
} from '@kv/shared';
import { DecryptError, SecretMissingError, appSecretProblem, openApiKey, sealApiKey } from './secret-box';

type Env = Record<string, string | undefined>;

export interface SettingsServiceOptions {
  env?: Env;
  now?: () => number;
  /** Validade do cache do que foi lido do banco (padrão 5 s). */
  ttlMs?: number;
}

/** A variável de ambiente da chave está definida: a tela não pode sobrescrevê-la. */
export class EnvKeyError extends Error {
  override name = 'EnvKeyError';
  constructor(readonly provider: AiProviderId) {
    super(`A chave de ${AI_PROVIDER_LABELS[provider]} está definida pelo ambiente (${AI_KEY_ENV_VARS[provider]}) e não pode ser alterada pela tela.`);
  }
}

/** Valor recusado por uma regra que depende do ambiente (ex.: provedor falso fora do modo de teste). */
export class SettingsValidationError extends Error {
  override name = 'SettingsValidationError';
}

/** Os valores em vigor, cada um com a origem. Nada aqui é segredo. */
export interface ResolvedSettings {
  provider: SettingValue<AiProviderId | 'fake' | null>;
  modelFast: SettingValue<string | null>;
  modelStrong: SettingValue<string | null>;
  dailyBudgetUsd: SettingValue<number>;
  tier1Enabled: SettingValue<boolean>;
  tier2Auto: SettingValue<boolean>;
  greenhouseBoards: SettingValue<string[]>;
  leverCompanies: SettingValue<string[]>;
  /** Modos e limites já completados com os padrões (a tela grava só o que mudou). */
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
  budgetTimeZone: string;
}

/** O estado da IA sem a chave: é o que a API e a fila precisam para decidir o que fazer. */
export interface AiSettingsStatus {
  configured: boolean;
  problem: string | null;
  provider: string | null;
  models: { fast: string; strong: string } | null;
  dailyBudgetUsd: number;
  budgetTimeZone: string;
  tier1Enabled: boolean;
  tier2Auto: boolean;
}

interface KeyRow {
  sealed: Buffer;
  last4: string;
  updatedAt: number;
}

/** O que fica em cache: linhas do banco como vieram. As chaves estão CIFRADAS aqui; nada decifrado é guardado. */
interface Snapshot {
  stored: Partial<Record<SettingKey, unknown>>;
  keys: Map<AiProviderId, KeyRow>;
  loadedAt: number;
}

const isProviderId = (value: string): value is AiProviderId => (AI_PROVIDER_IDS as readonly string[]).includes(value);
const splitList = (raw: string | undefined) => (raw ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Serviço de configurações, usado pela API e pelo worker (cada processo cria o seu).
 *
 * - Precedência dos valores não secretos: gravado pela tela (tabela `settings`) > variável de ambiente >
 *   padrão do código. Uma linha do banco que não passa na validação é ignorada.
 * - Chave de API: a variável de ambiente do provedor, se definida; senão a gravada pela tela, decifrada.
 * - Cache de `ttlMs` (5 s) do que foi lido do banco, invalidado na hora por qualquer gravação feita neste
 *   processo. O outro processo enxerga a mudança em até `ttlMs`: nada precisa ser reiniciado.
 * - A chave decifrada NUNCA entra no cache: `aiConfig()` decifra a cada chamada e devolve a chave só
 *   dentro do `AiConfig`, que vive o tempo de uma unidade de trabalho (uma tarefa da fila, um teste de
 *   conexão). Decifrar custa microssegundos.
 */
export function createSettingsService(db: Db, opts: SettingsServiceOptions = {}) {
  const { env = process.env, now = Date.now, ttlMs = 5_000 } = opts;
  let snapshot: Snapshot | null = null;

  const fakeAllowed = () => env.AI_ALLOW_FAKE === '1' || env.AI_PROVIDER?.trim().toLowerCase() === 'fake';
  const envKey = (provider: AiProviderId) => env[AI_KEY_ENV_VARS[provider]]?.trim() || null;

  async function load(): Promise<Snapshot> {
    if (snapshot && now() - snapshot.loadedAt < ttlMs) return snapshot;
    const rows = await db.select().from(settingsTable);
    const stored: Snapshot['stored'] = {};
    for (const row of rows) {
      if (!(SETTING_KEYS as readonly string[]).includes(row.key)) continue;
      const key = row.key as SettingKey;
      const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
      if (parsed.success) stored[key] = parsed.data;
    }
    const keys = new Map<AiProviderId, KeyRow>();
    for (const row of await db.select().from(aiKeys)) {
      if (isProviderId(row.provider)) keys.set(row.provider, { sealed: row.sealed, last4: row.last4, updatedAt: row.updatedAt });
    }
    snapshot = { stored, keys, loadedAt: now() };
    return snapshot;
  }

  function resolve(stored: Snapshot['stored']): ResolvedSettings {
    const pick = <T>(ui: T | undefined, fromEnv: T | undefined, fallback: T): SettingValue<T> =>
      ui !== undefined ? { value: ui, source: 'ui' } : fromEnv !== undefined ? { value: fromEnv, source: 'env' } : { value: fallback, source: 'default' };

    const envProvider = env.AI_PROVIDER?.trim().toLowerCase();
    const uiProvider = stored.provider as AiProviderId | 'fake' | undefined;
    const provider = pick<AiProviderId | 'fake' | null>(
      uiProvider === 'fake' && !fakeAllowed() ? undefined : uiProvider,
      envProvider && (isProviderId(envProvider) || envProvider === 'fake') ? envProvider : undefined,
      null,
    );
    const defaults = provider.value ? DEFAULT_MODELS[provider.value] : null;
    const envBudget = env.AI_DAILY_BUDGET_USD?.trim() ? Number(env.AI_DAILY_BUDGET_USD) : NaN;
    const envList = (name: string) => (splitList(env[name]).length > 0 ? splitList(env[name]) : undefined);
    const tz = env.AI_BUDGET_TZ?.trim();
    const modes = pick<Partial<Record<ApplySiteId, ApplyMode>>>(stored.applySiteModes as Partial<Record<ApplySiteId, ApplyMode>> | undefined, undefined, {});
    const caps = pick<Partial<ApplyDailyCaps>>(stored.applyDailyCaps as Partial<ApplyDailyCaps> | undefined, undefined, {});
    return {
      provider,
      modelFast: pick<string | null>(stored.modelFast as string | undefined, env.AI_MODEL_FAST?.trim() || undefined, defaults?.fast ?? null),
      modelStrong: pick<string | null>(stored.modelStrong as string | undefined, env.AI_MODEL_STRONG?.trim() || undefined, defaults?.strong ?? null),
      dailyBudgetUsd: pick(
        stored.dailyBudgetUsd as number | undefined,
        Number.isFinite(envBudget) && envBudget >= 0 ? envBudget : undefined,
        DEFAULT_DAILY_BUDGET_USD,
      ),
      tier1Enabled: pick(stored.tier1Enabled as boolean | undefined, undefined, true),
      // Desligada por padrão: cada análise usa o modelo forte e custa bem mais que a nota da camada 1.
      tier2Auto: pick(stored.tier2Auto as boolean | undefined, undefined, false),
      greenhouseBoards: pick(stored.greenhouseBoards as string[] | undefined, envList('GREENHOUSE_BOARDS'), [...DEFAULT_GREENHOUSE_BOARDS]),
      leverCompanies: pick(stored.leverCompanies as string[] | undefined, envList('LEVER_COMPANIES'), [...DEFAULT_LEVER_COMPANIES]),
      apply: {
        enabled: pick(stored.applyEnabled as boolean | undefined, undefined, false),
        minScore: pick(stored.applyMinScore as number | undefined, undefined, APPLY_DEFAULTS.minScore),
        siteModes: {
          source: modes.source,
          value: Object.fromEntries(APPLY_SITE_IDS.map((id) => [id, modes.value[id] ?? 'dry_run'])) as Record<ApplySiteId, ApplyMode>,
        },
        dailyCaps: { source: caps.source, value: { ...APPLY_DEFAULTS.dailyCaps, ...caps.value } },
        companyCap: pick(stored.applyCompanyCap as number | undefined, undefined, APPLY_DEFAULTS.companyCap),
        window: pick<ApplyWindow>(stored.applyWindow as ApplyWindow | undefined, undefined, { ...APPLY_DEFAULTS.window }),
        resumeMode: pick<ApplyResumeMode>(stored.applyResumeMode as ApplyResumeMode | undefined, undefined, 'tailored'),
        openAnswers: pick(stored.applyOpenAnswers as boolean | undefined, undefined, true),
        blockedCompanies: pick<string[]>(stored.applyBlockedCompanies as string[] | undefined, undefined, []),
        blockedTerms: pick<string[]>(stored.applyBlockedTerms as string[] | undefined, undefined, []),
      },
      budgetTimeZone: tz && isTimeZone(tz) ? tz : DEFAULT_BUDGET_TIME_ZONE,
    };
  }

  /** A chave em uso de um provedor, ou por que não há. A chave decifrada só existe no valor devolvido. */
  function keyFor(provider: AiProviderId, keys: Snapshot['keys']): { key: string } | { problem: string; code: AiKeyMetaDto['problem'] } {
    const fromEnv = envKey(provider);
    if (fromEnv) return { key: fromEnv };
    const row = keys.get(provider);
    const label = AI_PROVIDER_LABELS[provider];
    if (!row) {
      return { problem: `Falta a chave de API de ${label}. Grave uma em Configurações ou defina ${AI_KEY_ENV_VARS[provider]}.`, code: null };
    }
    try {
      return { key: openApiKey(row.sealed, provider, env.APP_SECRET) };
    } catch (e) {
      if (e instanceof SecretMissingError) {
        return { problem: `Há uma chave de ${label} gravada, mas ela não pode ser lida: ${e.message}`, code: 'no_secret' };
      }
      if (e instanceof DecryptError) {
        return {
          problem: `A chave de ${label} gravada não pôde ser decifrada (APP_SECRET mudou?). Grave a chave de novo em Configurações.`,
          code: 'undecryptable',
        };
      }
      throw e;
    }
  }

  function keyMeta(provider: AiProviderId, keys: Snapshot['keys']): AiKeyMetaDto {
    const row = keys.get(provider);
    const hasStored = row !== undefined;
    // A chave do ambiente não tem os últimos caracteres expostos: a tela só diz "definida pelo ambiente".
    if (envKey(provider)) return { provider, source: 'env', last4: null, savedAt: null, usable: true, problem: null, hasStored };
    if (!row) return { provider, source: 'none', last4: null, savedAt: null, usable: false, problem: null, hasStored };
    const result = keyFor(provider, keys);
    return {
      provider, source: 'stored', last4: row.last4, savedAt: row.updatedAt, hasStored,
      usable: 'key' in result,
      problem: 'key' in result ? null : result.code,
    };
  }

  /**
   * Configuração completa da IA, COM a chave. Use e descarte: não guarde o resultado além da unidade de
   * trabalho. `overrideProvider` serve ao roteiro `ai:smoke`, que testa um provedor por vez.
   */
  async function aiConfig(overrideProvider?: AiProviderId): Promise<AiConfigResult> {
    const snap = await load();
    const resolved = resolve(snap.stored);
    const provider = overrideProvider ?? resolved.provider.value;
    if (!provider) return { config: null, problem: 'Nenhum provedor de IA escolhido. Escolha um em Configurações.' };
    let apiKey = 'fake';
    if (provider !== 'fake') {
      const result = keyFor(provider, snap.keys);
      if (!('key' in result)) return { config: null, problem: result.problem };
      apiKey = result.key;
    }
    const models = overrideProvider && overrideProvider !== resolved.provider.value ? DEFAULT_MODELS[overrideProvider] : null;
    return resolveAiConfig({
      AI_PROVIDER: provider,
      ...(provider === 'fake' ? {} : { [AI_KEY_ENV_VARS[provider]]: apiKey }),
      AI_MODEL_FAST: models?.fast ?? resolved.modelFast.value ?? undefined,
      AI_MODEL_STRONG: models?.strong ?? resolved.modelStrong.value ?? undefined,
      AI_DAILY_BUDGET_USD: String(resolved.dailyBudgetUsd.value),
      AI_BUDGET_TZ: resolved.budgetTimeZone,
    });
  }

  async function status(): Promise<AiSettingsStatus> {
    const resolved = resolve((await load()).stored);
    const { config, problem } = await aiConfig();
    return {
      configured: config !== null,
      problem,
      provider: config?.provider ?? resolved.provider.value,
      models: config?.models ?? null,
      dailyBudgetUsd: resolved.dailyBudgetUsd.value,
      budgetTimeZone: resolved.budgetTimeZone,
      tier1Enabled: resolved.tier1Enabled.value,
      tier2Auto: resolved.tier2Auto.value,
    };
  }

  return {
    /** Os valores em vigor (sem segredos), com a origem de cada um. */
    get: async (): Promise<ResolvedSettings> => resolve((await load()).stored),
    aiConfig,
    status,
    /** Por que não dá para gravar chave pela tela; null quando dá. */
    secretProblem: (): string | null => appSecretProblem(env.APP_SECRET),
    /** Listas de empresas para os conectores Greenhouse e Lever (o worker passa isto a `connector.search`). */
    async connectorConfig(): Promise<{ greenhouseBoards: string[]; leverCompanies: string[] }> {
      const resolved = resolve((await load()).stored);
      return { greenhouseBoards: resolved.greenhouseBoards.value, leverCompanies: resolved.leverCompanies.value };
    },
    /** As configurações de candidatura automática em vigor, para a API e o worker. */
    async applyConfig(): Promise<ApplyConfig> {
      const { apply: a, budgetTimeZone } = resolve((await load()).stored);
      return {
        enabled: a.enabled.value, minScore: a.minScore.value, siteModes: a.siteModes.value, dailyCaps: a.dailyCaps.value,
        companyCap: a.companyCap.value, window: a.window.value, resumeMode: a.resumeMode.value, openAnswers: a.openAnswers.value,
        blockedCompanies: a.blockedCompanies.value, blockedTerms: a.blockedTerms.value, timeZone: budgetTimeZone,
      };
    },
    /** Descarta o cache: a próxima leitura vai ao banco. */
    invalidate(): void {
      snapshot = null;
    },

    /** Grava (ou apaga, com `null`) as configurações do patch já validado por `SettingsPatchSchema`. */
    async update(patch: SettingsPatch): Promise<ResolvedSettings> {
      if (patch.provider === 'fake' && !fakeAllowed()) {
        throw new SettingsValidationError('provider: o provedor falso só existe em modo de teste');
      }
      const at = now();
      await db.transaction(async (tx) => {
        for (const key of SETTING_KEYS) {
          const value = patch[key];
          if (value === undefined) continue;
          if (value === null) await tx.delete(settingsTable).where(eq(settingsTable.key, key));
          else {
            await tx
              .insert(settingsTable)
              .values({ key, value, updatedAt: at })
              .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: at } });
          }
        }
      });
      snapshot = null;
      return resolve((await load()).stored);
    },

    async keys(): Promise<AiKeyMetaDto[]> {
      const snap = await load();
      return AI_PROVIDER_IDS.map((provider) => keyMeta(provider, snap.keys));
    },

    /** Cifra e grava a chave de um provedor. Lança EnvKeyError ou SecretMissingError. O texto puro não é guardado. */
    async saveKey(provider: AiProviderId, plaintext: string): Promise<AiKeyMetaDto> {
      if (envKey(provider)) throw new EnvKeyError(provider);
      const values = { sealed: sealApiKey(plaintext, provider, env.APP_SECRET), last4: plaintext.slice(-4), updatedAt: now() };
      await db.insert(aiKeys).values({ provider, ...values }).onConflictDoUpdate({ target: aiKeys.provider, set: values });
      snapshot = null;
      return keyMeta(provider, (await load()).keys);
    },

    async deleteKey(provider: AiProviderId): Promise<void> {
      await db.delete(aiKeys).where(eq(aiKeys.provider, provider));
      snapshot = null;
    },

    /** O DTO da aba Configurações. Só metadados das chaves. */
    async dto(nextRunAt: number): Promise<SettingsDto> {
      const snap = await load();
      const resolved = resolve(snap.stored);
      const state = await status();
      const src = <T>(v: SettingValue<T>): SettingValue<T> => ({ value: v.value, source: v.source as SettingSource });
      const providers: string[] = [...AI_PROVIDER_IDS, ...(fakeAllowed() ? ['fake'] : [])];
      return {
        ai: {
          providers,
          provider: src(resolved.provider),
          modelFast: src(resolved.modelFast),
          modelStrong: src(resolved.modelStrong),
          defaultModels: Object.fromEntries(providers.map((p) => [p, DEFAULT_MODELS[p as AiProviderId | 'fake']])),
          dailyBudgetUsd: src(resolved.dailyBudgetUsd),
          tier1Enabled: src(resolved.tier1Enabled),
          tier2Auto: src(resolved.tier2Auto),
          keys: AI_PROVIDER_IDS.map((provider) => keyMeta(provider, snap.keys)),
          canStoreKeys: appSecretProblem(env.APP_SECRET) === null,
          secretProblem: appSecretProblem(env.APP_SECRET),
          configured: state.configured,
          problem: state.problem,
          budgetTimeZone: resolved.budgetTimeZone,
        },
        apply: {
          enabled: src(resolved.apply.enabled),
          minScore: src(resolved.apply.minScore),
          siteModes: src(resolved.apply.siteModes),
          dailyCaps: src(resolved.apply.dailyCaps),
          companyCap: src(resolved.apply.companyCap),
          window: src(resolved.apply.window),
          resumeMode: src(resolved.apply.resumeMode),
          openAnswers: src(resolved.apply.openAnswers),
          blockedCompanies: src(resolved.apply.blockedCompanies),
          blockedTerms: src(resolved.apply.blockedTerms),
        },
        sources: { greenhouseBoards: src(resolved.greenhouseBoards), leverCompanies: src(resolved.leverCompanies) },
        general: { nextRunAt },
      };
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
