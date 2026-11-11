import { and, asc, eq, inArray, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { AiError, dayStartMs, isContentFailure, isProviderUnavailable, isRetryable, isTimeout } from '@kv/ai';
import { aiSpentSince, aiTasks, providerWait, pruneAiTasks, type AiTaskRow, type Db } from '@kv/db';
import type { AiTaskType } from '@kv/shared';
import { describeForLog, isUnknownError, taskErrorMessage } from './task-errors';

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
  /**
   * Quanto a triagem (camada 1) espera quando o provedor está indisponível, por tipo de erro: `config` (chave
   * recusada, sem crédito, modelo inexistente; padrão 30 min) e `rate_limited` (padrão 15 min).
   */
  providerPauseMs?: { config: number; rate_limited: number };
  /** Tarefas terminadas (ok ou erro) são apagadas depois deste tempo (padrão 30 dias). */
  retentionMs?: number;
  /** Enfileira a camada 1 das vagas novas; chamado a cada verificação enquanto há orçamento. */
  sweep?: () => Promise<number>;
  /** Chamado quando uma tarefa falha de vez (para marcar o estado da camada na vaga). */
  onFailed?: (task: AiTaskRow, message: string) => Promise<void>;
  /**
   * Chamado para cada tarefa encontrada "running" sem ninguém a executando (o processo morreu ou travou no meio
   * da chamada): é onde o uso estimado da chamada perdida é registrado. Não deve lançar.
   */
  onInterrupted?: (task: AiTaskRow) => Promise<void>;
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
  /** Tarefas terminadas antigas apagadas nesta verificação. */
  pruned: number;
}

/**
 * Tempo limite de uma unidade, por tipo de tarefa. Sempre MAIOR que o tempo limite HTTP do adaptador
 * (`CALL_TIMEOUT_MS` em @kv/ai: 120 s no nível rápido, 480 s no forte): quem corta primeiro é o SDK, com um erro
 * limpo; a fila é a rede de segurança, e a única trava do corpo de uma resposta em streaming.
 * - camada 1 (nível rápido, uma chamada): 120 s + folga;
 * - camada 2 e perfil (nível forte, uma chamada, mais a busca da descrição na camada 2): 480 s + folga;
 * - camada 3: até DUAS chamadas fortes seguidas (a nova tentativa depois de um rascunho bloqueado).
 */
const DEFAULT_TIMEOUT_MS: Record<AiTaskType, number> = {
  tier1: 150_000, tier2: 540_000, tier3: 1_020_000, profile_extract: 510_000, profile_translate: 510_000,
};
/** Folga somada ao maior tempo limite antes de considerar uma tarefa abandonada. */
const STALE_MARGIN_MS = 3 * 60_000;
/**
 * Uma chamada do nível forte abortada por tempo ganha no máximo UMA nova tentativa: a mesma chamada tende a
 * demorar o mesmo, e cada tentativa pode ter sido cobrada.
 */
const STRONG_TIMEOUT_ATTEMPTS = 2;
const DEFAULT_PROVIDER_PAUSE_MS = { config: 30 * 60_000, rate_limited: 15 * 60_000 };
const DEFAULT_RETENTION_MS = 30 * 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
/** Ordem de saída da fila: o que o usuário pediu agora primeiro, a triagem em massa por último. */
const PRIORITY = sql`case ${aiTasks.type}
  when 'profile_extract' then 0 when 'profile_translate' then 0 when 'tier3' then 1 when 'tier2' then 2 else 3 end`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A fila de IA do worker, separada da fila de busca (`createQueue` em scheduler.ts): tem concorrência,
 * tempo limite, novas tentativas e limpeza próprios, e `tick()` nunca espera uma chamada de IA terminar.
 * Lentidão ou falha do provedor não atrasa a busca de vagas.
 *
 * A cada verificação:
 * 0. apaga tarefas terminadas antigas (uma vez por hora) e lê as configurações em vigor (`settings()`); com a IA
 *    desligada, para por aqui;
 * 1. devolve à fila tarefas "running" abandonadas (nunca as que este processo está executando);
 * 2. soma o gasto do dia (`dayStartMs` no fuso do orçamento). Sem orçamento: tarefas da camada 1 e as
 *    demais ainda não confirmadas pelo usuário viram `blocked_budget`. Com orçamento: as bloqueadas
 *    voltam para a fila (é o que acontece na virada do dia) e a varredura de vagas novas roda (a menos que a
 *    triagem esteja em pausa por indisponibilidade do provedor);
 * 3. inicia tarefas da fila até `maxConcurrent` unidades, juntando a camada 1 em lotes.
 *
 * Quando uma tarefa falha (`fail`):
 * - camada 1 com o PROVEDOR indisponível (`config`, ou `rate_limited` depois das tentativas normais): a vaga NÃO
 *   é marcada. A tarefa e todas as outras da camada 1 na fila esperam `providerPauseMs`, sem tentativa contada, e
 *   a varredura para; `providerWait()` (@kv/db) é como a API mostra o motivo. Corrigir a configuração na tela
 *   libera as tarefas na hora (`resumeProviderWaits`);
 * - lote da camada 1 que falha INTEIRO por causa do conteúdo (`refused`, `invalid_output`, `truncated`): as vagas
 *   são refeitas uma a uma, na mesma unidade e respeitando o limite de gasto, para só a vaga culpada ser marcada;
 * - chamada do nível forte abortada por tempo: no máximo uma nova tentativa;
 * - o resto: nova tentativa com espera crescente até `maxAttempts`, depois erro definitivo (`onFailed`).
 */
export function createAiQueue(db: Db, run: UnitRunner, opts: AiQueueOptions) {
  const {
    settings,
    maxConcurrent = 2,
    batchSize = 10,
    maxAttempts = 3,
    backoffMs = [30_000, 120_000],
    abortGraceMs = 2_000,
    providerPauseMs = DEFAULT_PROVIDER_PAUSE_MS,
    retentionMs = DEFAULT_RETENTION_MS,
    sweep,
    onFailed,
    onInterrupted,
    now = Date.now,
    log = () => {},
  } = opts;
  const timeouts = { ...DEFAULT_TIMEOUT_MS, ...opts.timeoutMs };
  const staleAfterMs = opts.staleAfterMs ?? Math.max(...Object.values(timeouts)) + abortGraceMs + STALE_MARGIN_MS;

  /** Tarefas em execução neste processo. */
  const inFlight = new Set<number>();
  const running = new Set<Promise<void>>();
  let ticking = false;
  let lastPrune: number | undefined;

  /** O gasto de hoje já alcançou o limite? (Mesma conta da verificação, refeita antes de cada chamada individual.) */
  async function overBudget(): Promise<boolean> {
    const { dailyBudgetUsd, budgetTimeZone } = await settings();
    return (await aiSpentSince(db, dayStartMs(now(), budgetTimeZone))) >= dailyBudgetUsd;
  }

  /**
   * Põe a triagem em pausa: a tarefa que falhou e as demais da camada 1 que estão na fila esperam até `until`, com
   * o erro do provedor e sem tentativa contada (o problema não é delas). É por `attempts = 0` + erro que
   * `providerWait` as reconhece.
   */
  async function pauseTier1(task: AiTaskRow, message: string, until: number): Promise<void> {
    await db
      .update(aiTasks)
      .set({ status: 'queued', error: message, runAfter: until, attempts: 0 })
      .where(and(eq(aiTasks.type, 'tier1'), or(eq(aiTasks.id, task.id), eq(aiTasks.status, 'queued'))));
  }

  /** Registra a falha de uma tarefa. `attempts` = quantas tentativas ela já gastou, contando a que falhou. */
  async function fail(task: AiTaskRow, attempts: number, error: unknown): Promise<void> {
    const kind = error instanceof AiError ? error.kind : 'other';
    const message = taskErrorMessage(error);
    // Erro que não veio de um AiError (banco, bug): a tela recebe a frase fixa; o que aconteceu fica aqui.
    if (isUnknownError(error)) log(`fila de IA: tarefa ${task.id} (${task.type}) falhou com erro interno: ${describeForLog(error)}`);
    const exhausted =
      !isRetryable(kind) || attempts >= maxAttempts || (isTimeout(error) && task.type !== 'tier1' && attempts >= STRONG_TIMEOUT_ATTEMPTS);
    if (!exhausted) {
      const wait = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)] * (kind === 'rate_limited' ? 2 : 1);
      await db.update(aiTasks).set({ status: 'queued', error: message, runAfter: now() + wait }).where(eq(aiTasks.id, task.id));
      return;
    }
    if (task.type === 'tier1' && isProviderUnavailable(kind)) {
      const pause = kind === 'rate_limited' ? providerPauseMs.rate_limited : providerPauseMs.config;
      log(`fila de IA: triagem em pausa por ${Math.round(pause / 60_000)} min: ${message}`);
      await pauseTier1(task, message, now() + pause);
      return;
    }
    await db.update(aiTasks).set({ status: 'error', error: message, finishedAt: now() }).where(eq(aiTasks.id, task.id));
    await onFailed?.(task, message);
  }

  /**
   * Uma chamada ao runner com tempo limite: ao estourar, aborta o sinal e espera (um pouco) a chamada terminar.
   * Devolve as falhas por tarefa e, quando a unidade falhou INTEIRA, o erro (`whole`).
   */
  async function attempt(tasks: AiTaskRow[]): Promise<{ failures: Map<number, unknown>; whole?: unknown }> {
    const timeoutMs = Math.max(...tasks.map((t) => timeouts[t.type]));
    const controller = new AbortController();
    const work = Promise.resolve().then(() => run(tasks, controller.signal));
    const settled = work.then(
      () => {},
      () => {},
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AiError('transient', `tempo esgotado após ${timeoutMs / 1000} s`, 'timeout')), timeoutMs);
    });
    try {
      return { failures: (await Promise.race([work, timeout])) ?? new Map() };
    } catch (e) {
      if (!controller.signal.aborted) {
        controller.abort(e);
        await Promise.race([settled, sleep(abortGraceMs)]);
      }
      return { failures: new Map(tasks.map((t) => [t.id, e])), whole: e };
    } finally {
      clearTimeout(timer);
    }
  }

  async function settle(task: AiTaskRow, attempts: number, failures: Map<number, unknown>): Promise<void> {
    if (failures.has(task.id)) await fail(task, attempts, failures.get(task.id));
    else await db.update(aiTasks).set({ status: 'ok', error: null, finishedAt: now() }).where(eq(aiTasks.id, task.id));
  }

  /**
   * Um lote da camada 1 falhou inteiro por causa do conteúdo: refaz as vagas uma a uma (cada chamada conta uma
   * tentativa e tem o próprio tempo limite). Antes de cada chamada o limite de gasto é conferido de novo; sem
   * orçamento, as que faltam esperam o dia seguinte. Se o provedor ficar indisponível no meio, as que faltam
   * recebem o mesmo erro sem serem chamadas (e a triagem entra em pausa).
   */
  async function oneByOne(tasks: AiTaskRow[]): Promise<void> {
    let unavailable: unknown;
    for (const task of tasks) {
      if (unavailable !== undefined) {
        await fail(task, task.attempts + 1, unavailable);
        continue;
      }
      if (await overBudget()) {
        await db.update(aiTasks).set({ status: 'blocked_budget' }).where(eq(aiTasks.id, task.id));
        continue;
      }
      await db.update(aiTasks).set({ attempts: sql`${aiTasks.attempts} + 1`, startedAt: now() }).where(eq(aiTasks.id, task.id));
      const { failures } = await attempt([task]);
      await settle(task, task.attempts + 2, failures);
      if (isProviderUnavailable(failures.get(task.id))) unavailable = failures.get(task.id);
    }
  }

  async function execute(tasks: AiTaskRow[]): Promise<void> {
    const { failures, whole } = await attempt(tasks);
    if (whole !== undefined && tasks.length > 1 && isContentFailure(whole)) {
      log(`fila de IA: lote de ${tasks.length} vagas falhou (${errorText(whole)}); refazendo uma a uma`);
      await oneByOne(tasks);
      return;
    }
    for (const task of tasks) await settle(task, task.attempts + 1, failures);
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

  /**
   * Tarefas "running" que ninguém está executando: a chamada ao provedor se perdeu (e pode ter sido cobrada).
   * Registra o uso estimado (`onInterrupted`) e passa pela mesma `fail` de qualquer outra falha: a tentativa
   * interrompida já foi contada ao iniciar, então uma tarefa que derruba o processo toda vez para em `maxAttempts`.
   */
  async function interrupt(stale: AiTaskRow[]): Promise<number> {
    for (const task of stale) {
      await onInterrupted?.(task);
      await fail(task, task.attempts, new AiError('transient', 'execução interrompida'));
    }
    return stale.length;
  }

  const notMine = () => (inFlight.size > 0 ? notInArray(aiTasks.id, [...inFlight]) : undefined);

  async function requeueStale(): Promise<number> {
    return interrupt(
      await db
        .select()
        .from(aiTasks)
        .where(and(eq(aiTasks.status, 'running'), or(isNull(aiTasks.startedAt), lt(aiTasks.startedAt, now() - staleAfterMs)), notMine())),
    );
  }

  async function tick(): Promise<AiTickResult> {
    const result: AiTickResult = { started: 0, requeued: 0, blocked: 0, released: 0, swept: 0, pruned: 0 };
    if (ticking) return result; // a verificação anterior ainda está falando com o banco
    ticking = true;
    try {
      if (lastPrune === undefined || now() - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = now();
        result.pruned = await pruneAiTasks(db, now() - retentionMs);
      }
      result.requeued = await requeueStale();

      const { enabled, dailyBudgetUsd, budgetTimeZone, sweepEnabled } = await settings();
      // Sem provedor configurado nada roda nem é bloqueado: as tarefas ficam na fila até a IA ser ligada.
      if (!enabled) return result;

      const spent = (await aiSpentSince(db, dayStartMs(now(), budgetTimeZone))) >= dailyBudgetUsd;
      if (spent) {
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
        // Com a triagem em pausa (provedor indisponível) não adianta enfileirar mais vagas: elas entram quando a pausa acabar.
        if (sweep && sweepEnabled && !(await providerWait(db, now()))) {
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
            spent ? and(eq(aiTasks.confirmed, true), ne(aiTasks.type, 'tier1')) : undefined,
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
    /**
     * Só no start do worker: TODA tarefa "running" é de um processo anterior que morreu no meio da chamada.
     * Devolve quantas encontrou (cada uma voltou para a fila ou, sem tentativas, terminou em erro).
     */
    async recoverInterrupted(): Promise<number> {
      return interrupt(await db.select().from(aiTasks).where(and(eq(aiTasks.status, 'running'), notMine())));
    },
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
