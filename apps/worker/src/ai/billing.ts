import {
  AiError, estimateAbortedUsage, estimateCostUsd, isTimeout, type AiConfig, type AiProvider, type AiTier, type AiUsage,
} from '@kv/ai';
import { ESTIMATED_MODEL_SUFFIX, recordUsage, type Db } from '@kv/db';
import type { AiLayer } from '@kv/shared';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Billing {
  /** O provedor com a estimativa de uso anexada ao erro de uma chamada abortada. */
  provider: AiProvider;
  /** Faz a chamada e registra o uso na camada dada, venha resposta ou erro que carregue o uso. */
  billed<T extends { usage: AiUsage; model: string }>(layer: AiLayer, tier: AiTier, call: () => Promise<T>): Promise<T>;
}

/**
 * A cobrança das chamadas ao provedor de IA: toda chamada que foi paga grava uma linha em `ai_usage` (ver a regra
 * completa no comentário de `createExecutor`). Usada pelo executor da fila de IA e pela candidatura automática.
 */
export function createBilling(
  deps: { db: Db; now?: () => number; log?: (msg: string) => void },
  rawProvider: AiProvider,
  config: AiConfig,
): Billing {
  const { db, now = Date.now, log = () => {} } = deps;

  /** O provedor em vigor, com a estimativa de uso anexada ao erro de uma chamada abortada por tempo. */
  const provider: AiProvider = {
    id: rawProvider.id,
    async generate(req) {
      try {
        return await rawProvider.generate(req);
      } catch (e) {
        if (e instanceof AiError && !e.usage && (isTimeout(e) || req.signal?.aborted)) {
          e.usage = estimateAbortedUsage(req);
          e.estimated = true;
        }
        throw e;
      }
    },
  };

  async function charge(layer: AiLayer, tier: AiTier, res: { usage: AiUsage; model: string }, estimated = false): Promise<void> {
    await recordUsage(db, {
      provider: provider.id,
      model: estimated ? `${res.model}${ESTIMATED_MODEL_SUFFIX}` : res.model,
      layer,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: estimateCostUsd(res.model, res.usage, config.models[tier]),
      createdAt: now(),
    });
  }

  /**
   * Faz a chamada ao provedor e registra o uso, venha a resposta ou um erro que a carregue. Se gravar o uso
   * falhar depois de um erro, o erro do provedor é o que sobe (o do banco vai para o log).
   */
  async function billed<T extends { usage: AiUsage; model: string }>(layer: AiLayer, tier: AiTier, call: () => Promise<T>): Promise<T> {
    let res: T;
    try {
      res = await call();
    } catch (e) {
      if (e instanceof AiError && e.usage) {
        try {
          await charge(layer, tier, { usage: e.usage, model: e.model ?? config.models[tier] }, e.estimated === true);
        } catch (dbError) {
          log(`IA: não consegui registrar o uso de uma chamada que falhou (${layer}): ${errorText(dbError)}`);
        }
      }
      throw e;
    }
    await charge(layer, tier, res);
    return res;
  }

  return { provider, billed };
}
