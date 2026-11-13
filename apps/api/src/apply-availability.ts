import type { FastifyReply } from 'fastify';
import { applyWorkerState, type Db } from '@kv/db';
import { applyAvailability, type ApplyWorkerState } from '@kv/shared';

export interface ApplyAvailabilityNow {
  available: boolean;
  reason: string | null;
  /** O que o worker publicou da última vez (null: nenhum worker publicou ainda). */
  worker: ApplyWorkerState | null;
}

/**
 * A candidatura automática pode rodar agora? A API confere o próprio `HOST` (só com endereço local) e o que o worker
 * publicou: um worker que disse que não pode rodar (sem navegador, por exemplo) torna a função indisponível, com o motivo
 * dele. Sem publicação do worker, vale só o `HOST`.
 */
export async function applyAvailabilityNow(db: Db): Promise<ApplyAvailabilityNow> {
  const host = applyAvailability(process.env);
  const worker = await applyWorkerState(db);
  if (!host.available) return { available: false, reason: host.reason, worker };
  if (worker && !worker.available) {
    return { available: false, reason: worker.reason ?? 'O worker disse que a candidatura automática não pode rodar nele.', worker };
  }
  return { available: true, reason: null, worker };
}

export const unavailableBody = (reason: string | null) => ({
  error: 'apply_unavailable',
  message: reason ?? 'a candidatura automática não está disponível',
});

/**
 * Rotas que enfileiram trabalho para o worker (criar, tentar de novo, enviar, comandos de sessão): 409 `apply_unavailable`
 * com o motivo quando o host não é local OU o worker disse que não pode rodar. Devolve true se respondeu.
 */
export async function refuseUnlessWorkerCanRun(db: Db, reply: FastifyReply): Promise<boolean> {
  const now = await applyAvailabilityNow(db);
  if (now.available) return false;
  await reply.code(409).send(unavailableBody(now.reason));
  return true;
}

/**
 * As demais rotas que mudam estado da candidatura automática: 409 `apply_unavailable` fora de host local (API e worker
 * conferem cada um por si). As de leitura continuam respondendo. Devolve true se respondeu.
 */
export async function refuseOffLocalHost(reply: FastifyReply): Promise<boolean> {
  const host = applyAvailability(process.env);
  if (host.available) return false;
  await reply.code(409).send(unavailableBody(host.reason));
  return true;
}
