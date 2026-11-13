import { AiError, dayStartMs, type AiConfig, type AiProvider, type AiTier, type TaskResult } from '@kv/ai';
import { aiSpentSince, type Db } from '@kv/db';
import { createBilling } from '../ai/billing';

/** O limite diário de gasto com IA foi atingido antes de uma chamada do e-mail; a chamada não foi feita. */
export class MailBudgetError extends Error {
  constructor() {
    super('limite diário de IA atingido');
    this.name = 'MailBudgetError';
  }
}

export interface MailAi {
  /** Há IA configurada (provedor e chave)? Sem ela, `ai()` lança `AiError('config')`; qualquer outro erro sobe. */
  configured(): Promise<boolean>;
  /** O gasto de hoje (no fuso do orçamento) ainda está abaixo do limite diário? */
  mayCall(): Promise<boolean>;
  /** Chamada cobrada na camada `email`. Sem orçamento e sem `force`: lança MailBudgetError, sem chamada. */
  call<T>(tier: AiTier, fn: (provider: AiProvider) => Promise<TaskResult<T>>, opts?: { force?: boolean }): Promise<TaskResult<T>>;
}

/**
 * A IA da fila de e-mail. Ao contrário da candidatura (uma IA por candidatura), a fila vive o processo inteiro: o
 * provedor e a configuração são lidos a cada pergunta, para que uma chave ou um limite trocado na tela valha na
 * próxima mensagem sem reiniciar o worker.
 */
export function createMailAi(deps: {
  db: Db; ai: () => Promise<{ provider: AiProvider; config: AiConfig }>; now: () => number; log: (msg: string) => void;
}): MailAi {
  const { db, now, log } = deps;

  async function mayCallWith(config: AiConfig): Promise<boolean> {
    return (await aiSpentSince(db, dayStartMs(now(), config.budgetTimeZone))) < config.dailyBudgetUsd;
  }

  return {
    async configured() {
      try {
        await deps.ai();
        return true;
      } catch (e) {
        if (e instanceof AiError && e.kind === 'config') return false;
        throw e;
      }
    },
    async mayCall() {
      return mayCallWith((await deps.ai()).config);
    },
    async call(tier, fn, opts = {}) {
      const { provider, config } = await deps.ai();
      if (!opts.force && !(await mayCallWith(config))) throw new MailBudgetError();
      const billing = createBilling({ db, now, log }, provider, config);
      return billing.billed('email', tier, () => fn(billing.provider));
    },
  };
}
