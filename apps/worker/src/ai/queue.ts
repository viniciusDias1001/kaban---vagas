import { and, asc, eq, inArray, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { AiError, dayStartMs, isRetryable } from '@kv/ai';
import { aiSpentSince, aiTasks, type AiTaskRow, type Db } from '@kv/db';
import type { AiTaskType } from '@kv/shared';

/**
 * Executa uma unidade de trabalho: uma tarefa, ou um lote de tarefas da camada 1. Devolve as falhas por
 * id de tarefa (mapa vazio ou nada = todas deram certo); lançar = todas falharam. `signal` é abortado
 * quando a unidade estoura o tempo.
 */
export type UnitRunner = (tasks: AiTaskRow[], signal: AbortSignal) => Promise<Map<number, unknown> | void>;

/** O que a fila pergunta ao serviço de configurações a cada verificação. */
export interface AiQueueSettings {
  /** A IA está configurada (provedor e chave utilizável). false = a fila não inicia nada; as tarefas esperam. */
  enabled: boolean;
  /** Limite de gasto do dia e o fuso que define o dia. */
  dailyBudgetUsd: number;
  budgetTimeZone: string;
  /** Triagem automática das vagas novas (camada 1) ligada. */
  sweepEnabled: boolean;
}

export interface AiQueueOptions {
  /**
   * Lida a CADA verificação (o serviço tem cache de poucos segundos): trocar provedor, chave, limite ou
   * desligar a triagem na aba Configurações vale na verificação seguinte, sem reiniciar o worker.
   */
  settings: () => Promise<AiQueueSettings>;
  /** Unidades ao mesmo tempo (padrão 2). Um lote da camada 1 conta como uma. */
  maxConcurrent?: number;
  /** Tarefas da camada 1 por lote (padrão 10). */
  batchSize?: number;
  /** Tentativas no total, contando a primeira (padrão 3). */
  maxAttempts?: number;
  /** Espera antes da 2ª e da 3ª tentativa (padrão 30 s e 120 s; o dobro em limite de taxa). */
  backoffMs?: number[];
  /** Tempo limite de uma unidade, por tipo de tarefa. */
  timeoutMs?: Partial<Record<AiTaskType, number>>;
  /** Depois de abortar uma unidade que estourou o tempo, quanto esperar ela terminar (padrão 2 s). */
  abortGraceMs?: number;
  /** Idade (desde `started_at`) a partir da qual uma tarefa "running" de fora deste processo é devolvida à fila. */
  staleAfterMs?: number;
  /** Enfileira a camada 1 das vagas novas; chamado a cada verificação enquanto há orçamento. */
  sweep?: () => Promise<number>;
  /** Chamado quando uma tarefa falha de vez (para marcar o estado da camada na vaga). */
  onFailed?: (task: AiTaskRow, message: string) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface AiTickResult {
  /** Unidades iniciadas nesta verificação. */
  started: number;
  /** Tarefas "running" abandonadas devolvidas à fila (ou encerradas, se já sem tentativas). */
  requeued: number;
  /** Tarefas paradas pelo limite de gasto nesta verificação. */
  blocked: number;
  /** Tarefas liberadas porque voltou a haver orçamento (virada do dia). */
  released: number;
  /** Tarefas da camada 1 enfileiradas pela varredura de vagas novas. */
  swept: number;
}

const DEFAULT_TIMEOUT_MS: Record<AiTaskType, number> = {
  tier1: 60_000, tier2: 100_000, tier3: 100_000, profile_extract: 100_000, profile_translate: 100_000,
};
/** Folga somada ao maior tempo limite antes de considerar uma tarefa abandonada. */
const STALE_MARGIN_MS = 3 * 60_000;
/** Ordem de saída da fila: o que o usuário pediu agora primeiro, a triagem em massa por último. */
const PRIORITY = sql`case ${aiTasks.type}
  when 'profile_extract' then 0 when 'profile_translate' then 0 when 'tier3' then 1 when 'tier2' then 2 else 3 end`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Tarefas que ficaram "running" de um processo anterior voltam para a fila. Só no start do worker. */
export async function requeueRunningAiTasks(db: Db): Promise<number> {
  const rows = await db.update(aiTasks).set({ status: 'queued' }).where(eq(aiTasks.status, 'running')).returning({ id: aiTasks.id });
  return rows.length;
}

/**
 * A fila de IA do worker, separada da fila de busca (`createQueue` em scheduler.ts): tem concorrência,
 * tempo limite, novas tentativas e limpeza próprios, e `tick()` nunca espera uma chamada de IA terminar.
 * Lentidão ou falha do provedor não atrasa a busca de vagas.
 *
 * A cada verificação:
 * 0. lê as configurações em vigor (`settings()`); com a IA desligada, para por aqui;
 * 1. devolve à fila tarefas "running" abandonadas (nunca as que este processo está executando);
 * 2. soma o gasto do dia (`dayStartMs` no fuso do orçamento). Sem orçamento: tarefas da camada 1 e as
 *    demais ainda não confirmadas pelo usuário viram `blocked_budget`. Com orçamento: as bloqueadas
 *    voltam para a fila (é o que acontece na virada do dia) e a varredura de vagas novas roda;
 * 3. inicia tarefas da fila até `maxConcurrent` unidades, juntando a camada 1 em lotes.
 */
export function createAiQueue(db: Db, run: UnitRunner, opts: AiQueueOptions) {
  const {
    settings,
    maxConcurrent = 2,
    batchSize = 10,
    maxAttempts = 3,
    backoffMs = [30_000, 120_000],
    abortGraceMs = 2_000,
    sweep,
    onFailed,
    now = Date.now,
    log = () => {},
  } = opts;
  const timeouts = { ...DEFAULT_TIMEOUT_MS, ...opts.timeoutMs };
  const staleAfterMs = opts.staleAfterMs ?? Math.max(...Object.values(timeouts)) + abortGraceMs + STALE_MARGIN_MS;

  /** Tarefas em execução neste processo. */
  const inFlight = new Set<number>();
  const running = new Set<Promise<void>>();
  let ticking = false;

  async function fail(task: AiTaskRow, attempts: number, error: unknown): Promise<void> {
    const kind = error instanceof AiError ? error.kind : 'other';
    const message = errorText(error).slice(0, 2_000);
    if (!isRetryable(kind) || attempts >= maxAttempts) {
      await db.update(aiTasks).set({ status: 'error', error: message, finishedAt: now() }).where(eq(aiTasks.id, task.id));
      await onFailed?.(task, message);
      return;
    }
    const wait = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)] * (kind === 'rate_limited' ? 2 : 1);
    await db.update(aiTasks).set({ status: 'queued', error: message, runAfter: now() + wait }).where(eq(aiTasks.id, task.id));
  }

  /** Roda a unidade com tempo limite: ao estourar, aborta o sinal e espera (um pouco) a chamada terminar. */
  async function execute(tasks: AiTaskRow[]): Promise<void> {
    const timeoutMs = Math.max(...tasks.map((t) => timeouts[t.type]));
    const controller = new AbortController();
    const work = Promise.resolve().then(() => run(tasks, controller.signal));
    const settled = work.then(
      () => {},
      () => {},
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AiError('transient', `tempo esgotado após ${timeoutMs / 1000} s`)), timeoutMs);
    });
    let failures: Map<number, unknown>;
    try {
      failures = (await Promise.race([work, timeout])) ?? new Map();
    } catch (e) {
      if (!controller.signal.aborted) {
        controller.abort(e);
        await Promise.race([settled, sleep(abortGraceMs)]);
      }
      failures = new Map(tasks.map((t) => [t.id, e]));
    } finally {
      clearTimeout(timer);
    }
    for (const task of tasks) {
      if (failures.has(task.id)) await fail(task, task.attempts + 1, failures.get(task.id));
      else await db.update(aiTasks).set({ status: 'ok', error: null, finishedAt: now() }).where(eq(aiTasks.id, task.id));
    }
  }

  async function start(tasks: AiTaskRow[]): Promise<void> {
    const ids = tasks.map((t) => t.id);
    await db
      .update(aiTasks)
      .set({ status: 'running', startedAt: now(), attempts: sql`${aiTasks.attempts} + 1` })
      .where(inArray(aiTasks.id, ids));
    for (const id of ids) inFlight.add(id);
    const done = execute(tasks)
      // O próprio banco falhou e não há onde registrar: as tarefas ficam "running" e a limpeza as devolve depois.
      .catch((e) => log(`fila de IA: tarefas ${ids.join(', ')}: ${errorText(e)}`))
      .finally(() => {
        for (const id of ids) inFlight.delete(id);
        running.delete(done);
      });
    running.add(done);
  }

  async function requeueStale(): Promise<number> {
    const stale = await db
      .select()
      .from(aiTasks)
      .where(
        and(
          eq(aiTasks.status, 'running'),
          or(isNull(aiTasks.startedAt), lt(aiTasks.startedAt, now() - staleAfterMs)),
          inFlight.size > 0 ? notInArray(aiTasks.id, [...inFlight]) : undefined,
        ),
      );
    for (const task of stale) await fail(task, task.attempts, new AiError('transient', 'execução interrompida'));
    return stale.length;
  }

  async function tick(): Promise<AiTickResult> {
    const result: AiTickResult = { started: 0, requeued: 0, blocked: 0, released: 0, swept: 0 };
    if (ticking) return result; // a verificação anterior ainda está falando com o banco
    ticking = true;
    try {
      result.requeued = await requeueStale();

      const { enabled, dailyBudgetUsd, budgetTimeZone, sweepEnabled } = await settings();
      // Sem provedor configurado nada roda nem é bloqueado: as tarefas ficam na fila até a IA ser ligada.
      if (!enabled) return result;

      const overBudget = (await aiSpentSince(db, dayStartMs(now(), budgetTimeZone))) >= dailyBudgetUsd;
      if (overBudget) {
        // Camada 1 pausa até o dia seguinte; as demais esperam a confirmação do usuário.
        const blocked = await db
          .update(aiTasks)
          .set({ status: 'blocked_budget' })
          .where(and(eq(aiTasks.status, 'queued'), or(eq(aiTasks.type, 'tier1'), eq(aiTasks.confirmed, false))))
          .returning({ id: aiTasks.id });
        result.blocked = blocked.length;
      } else {
        const released = await db
          .update(aiTasks)
          .set({ status: 'queued' })
          .where(eq(aiTasks.status, 'blocked_budget'))
          .returning({ id: aiTasks.id });
        result.released = released.length;
        if (sweep && sweepEnabled) {
          try {
            result.swept = await sweep();
          } catch (e) {
            log(`fila de IA: erro ao enfileirar vagas novas: ${errorText(e)}`);
          }
        }
      }

      if (running.size >= maxConcurrent) return result;
      const queued = await db
        .select()
        .from(aiTasks)
        .where(
          and(
            eq(aiTasks.status, 'queued'),
            or(isNull(aiTasks.runAfter), lte(aiTasks.runAfter, now())),
            // Sem orçamento só passam as tarefas confirmadas (o UPDATE acima já tirou as outras da fila).
            overBudget ? and(eq(aiTasks.confirmed, true), ne(aiTasks.type, 'tier1')) : undefined,
          ),
        )
        .orderBy(PRIORITY, asc(aiTasks.id));

      const units: AiTaskRow[][] = [];
      let batch: AiTaskRow[] | undefined;
      for (const task of queued) {
        if (inFlight.has(task.id)) continue;
        if (task.type !== 'tier1') units.push([task]);
        else if (batch && batch.length < batchSize) batch.push(task);
        else units.push((batch = [task]));
      }
      for (const unit of units) {
        if (running.size >= maxConcurrent) break;
        await start(unit);
        result.started++;
      }
      return result;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    /** Ids das tarefas em execução neste processo. */
    inFlightIds: () => [...inFlight],
    /** Resolve quando as unidades em execução neste momento terminarem. */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running]);
    },
    /** Verifica a fila repetidamente até não haver nada pronto nem em execução (testes e scripts). */
    async drain(): Promise<number> {
      let total = 0;
      for (;;) {
        const { started } = await tick();
        total += started;
        if (started === 0 && running.size === 0) return total;
        if (running.size > 0) await Promise.race([...running]);
      }
    },
  };
}

export type AiQueue = ReturnType<typeof createAiQueue>;
