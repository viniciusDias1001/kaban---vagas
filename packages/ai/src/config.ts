import type { AiProviderId, AiTier, AiUsage } from './types';

export const DEFAULT_MODELS: Record<AiProviderId | 'fake', Record<AiTier, string>> = {
  anthropic: { fast: 'claude-haiku-5-5', strong: 'claude-opus-5-5' },
  openai: { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' },
  gemini: { fast: 'gemini-3.5-flash-lite', strong: 'gemini-4-carbon' },
  fake: { fast: 'fake-fast', strong: 'fake-strong' },
};

/**
 * US$ por milhão de tokens. ESTIMATIVAS, lidas em 2026-11-11 nas páginas de preço dos provedores
 * (links no README e no plano). Só servem para estimar custo e aplicar AI_DAILY_BUDGET_USD; a fatura
 * do provedor é a verdade. Ao trocar de modelo por AI_MODEL_FAST/AI_MODEL_STRONG, acrescente o preço aqui.
 */
export const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 }, // prompts até 100K tokens
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 }, // destino possível do fallback de recusa
  'claude-opus-4-8': { input: 5, output: 25 }, // idem
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6.1-terra': { input: 1, output: 5 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-4-carbon': { input: 4, output: 20 }, // preço a partir de 2026-12-01 (até 30/11: 2 / 10)
  'fake-fast': { input: 0, output: 0 },
  'fake-strong': { input: 0, output: 0 },
};

/** Modelo sem preço cadastrado: estima pelo mais caro da tabela, para o limite diário errar para o lado seguro. */
const UNKNOWN_PRICE = { input: 10, output: 50 };

/** `fallbackModel` é o modelo configurado: usado quando o provedor devolve um nome com sufixo de versão. */
export function estimateCostUsd(model: string, usage: AiUsage, fallbackModel?: string): number {
  const price =
    PRICES_USD_PER_MTOK[model] ?? (fallbackModel ? PRICES_USD_PER_MTOK[fallbackModel] : undefined) ?? UNKNOWN_PRICE;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export interface AiConfig {
  provider: AiProviderId | 'fake';
  apiKey: string;
  models: Record<AiTier, string>;
  dailyBudgetUsd: number;
  /** Fuso que define o "dia" do orçamento. */
  budgetTimeZone: string;
}

export interface AiConfigResult {
  config: AiConfig | null;
  /** Por que não há configuração (texto para a interface); null quando há. */
  problem: string | null;
}

const KEY_VARS: Record<AiProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export const DEFAULT_DAILY_BUDGET_USD = 1;
export const DEFAULT_BUDGET_TIME_ZONE = 'America/Sao_Paulo';

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Monta a configuração de IA a partir de um mapa no formato das variáveis de ambiente. Função pura: quem
 * decide de onde vem cada valor (tela, ambiente ou padrão) e entrega a chave (do ambiente ou decifrada do
 * banco) é o serviço de configurações (`@kv/settings`). Ninguém mais deve chamá-la com `process.env`.
 */
export function resolveAiConfig(env: Record<string, string | undefined>): AiConfigResult {
  const provider = env.AI_PROVIDER?.trim().toLowerCase();
  if (!provider) return { config: null, problem: 'Nenhum provedor de IA escolhido.' };
  if (provider !== 'fake' && !(provider in KEY_VARS)) {
    return { config: null, problem: `O provedor "${provider}" não existe. Use anthropic, openai ou gemini.` };
  }
  const id = provider as AiProviderId | 'fake';
  const apiKey = id === 'fake' ? 'fake' : (env[KEY_VARS[id]]?.trim() ?? '');
  if (!apiKey) {
    return { config: null, problem: `Falta a chave de API do provedor ${id}.` };
  }
  const budget = Number(env.AI_DAILY_BUDGET_USD);
  const tz = env.AI_BUDGET_TZ?.trim();
  return {
    problem: null,
    config: {
      provider: id,
      apiKey,
      models: {
        fast: env.AI_MODEL_FAST?.trim() || DEFAULT_MODELS[id].fast,
        strong: env.AI_MODEL_STRONG?.trim() || DEFAULT_MODELS[id].strong,
      },
      dailyBudgetUsd: env.AI_DAILY_BUDGET_USD && Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_DAILY_BUDGET_USD,
      budgetTimeZone: tz && isTimeZone(tz) ? tz : DEFAULT_BUDGET_TIME_ZONE,
    },
  };
}
