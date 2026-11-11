import { AiError, createProvider } from '@kv/ai';
import { fetchJobDescription, type DescriptionFetcher } from '@kv/connectors';
import type { Db } from '@kv/db';
import type { SettingsService } from '@kv/settings';
import { createExecutor, createFailureRecorder, createInterruptionRecorder } from './executors';
import { createAiQueue, type AiQueue } from './queue';
import { enqueueTier1ForNewJobs } from './sweep';

export interface AiRuntimeOptions {
  fetchDescription?: DescriptionFetcher;
  log?: (msg: string) => void;
}

/**
 * Monta a fila de IA do worker. A fila existe sempre; quem diz se ela trabalha é o serviço de
 * configurações, consultado a cada verificação (cache de poucos segundos): sem provedor ou sem chave
 * utilizável a fila não inicia nada, e passa a trabalhar assim que a IA é configurada na aba
 * Configurações, sem reiniciar o worker.
 *
 * A chave de API só existe decifrada dentro de `ai()`, chamada uma vez por unidade de trabalho; o
 * provedor montado com ela é descartado quando a unidade termina.
 */
export function createAiRuntime(db: Db, settings: SettingsService, opts: AiRuntimeOptions = {}): AiQueue {
  const { fetchDescription = fetchJobDescription, log = () => {} } = opts;
  const ai = async () => {
    const { config, problem } = await settings.aiConfig();
    if (!config) throw new AiError('config', problem ?? 'IA não configurada');
    return { provider: createProvider(config), config };
  };
  const run = createExecutor({ db, fetchDescription, log, ai });
  return createAiQueue(db, run, {
    settings: async () => {
      const state = await settings.status();
      return {
        enabled: state.configured,
        dailyBudgetUsd: state.dailyBudgetUsd,
        budgetTimeZone: state.budgetTimeZone,
        sweepEnabled: state.tier1Enabled,
      };
    },
    sweep: () => enqueueTier1ForNewJobs(db),
    onFailed: createFailureRecorder(db),
    onInterrupted: createInterruptionRecorder({ db, ai, log }),
    log,
  });
}
