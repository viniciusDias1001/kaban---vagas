import { and, asc, eq, gt, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Connector } from '@kv/connectors';
import { enqueueRuns, runs, searchProfiles, type Db } from '@kv/db';
import { executeRun, maxSearchMs, type RunOptions } from './runner';

const HOUR = 3_600_000;

/** Verdadeiro se nenhum run terminou com sucesso na última hora. */
export async function isDue(db: Db, now: number = Date.now()): Promise<boolean> {
  const recent = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, 'ok'), gt(runs.finishedAt, now - HOUR)))
    .limit(1);
  return recent.length === 0;
}

/** Enfileira um run por fonte de cada perfil ativo. Devolve quantos enfileirou. */
export async function enqueueAllActive(db: Db): Promise<number> {
  const profiles = await db.select().from(searchProfiles).where(eq(searchProfiles.active, true));
  let total = 0;
  for (const p of profiles) total += await enqueueRuns(db, p, 'cron');
  return total;
}

/** Runs que ficaram em "running" de um processo anterior viram erro. Só no start do worker. */
export async function failStaleRuns(db: Db): Promise<void> {
  await db
    .update(runs)
    .set({ status: 'error', error: 'worker reiniciado', finishedAt: Date.now() })
    .where(eq(runs.status, 'running'));
}

/**
 * Encerra como erro os runs "running" que ninguém está executando: os que não estão em `inFlight` (os
 * deste processo) e começaram antes de `startedBefore`. É o caso do run cujo UPDATE final falhou porque
 * o banco caiu: sem isto ele ficaria "running" para sempre e, pelo índice único de pendentes, nenhum
 * outro run daquele perfil+fonte seria enfileirado. Devolve quantos encerrou.
 */
export async function reapStaleRuns(db: Db, inFlight: number[], startedBefore: number): Promise<number> {
  const reaped = await db
    .update(runs)
    .set({ status: 'error', error: 'execução interrompida', finishedAt: Date.now() })
    .where(
      and(
        eq(runs.status, 'running'),
        or(isNull(runs.startedAt), lt(runs.startedAt, startedBefore)),
        inFlight.length > 0 ? notInArray(runs.id, inFlight) : undefined,
      ),
    )
    .returning({ id: runs.id });
  return reaped.length;
}

/** Folga somada ao teto de busca de um run antes de considerá-lo abandonado (gravação das vagas etc.). */
const STALE_MARGIN_MS = 3 * 60_000;

export interface QueueOptions {
  /** Máximo de runs ao mesmo tempo, somando todas as fontes (padrão 4). */
  maxConcurrent?: number;
  /** Timeout e tentativas de cada run. */
  run?: RunOptions;
  /** Idade (desde `started_at`) a partir da qual um run "running" de fora deste processo é encerrado. */
  staleAfterMs?: number;
  /** Enfileira a busca horária; trocável nos testes. */
  enqueue?: () => Promise<number>;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface TickResult {
  /** Runs iniciados nesta verificação. */
  started: number;
  /** Runs "running" abandonados que foram encerrados como erro. */
  reaped: number;
  /** Runs enfileirados pela busca horária pendente, ou null se não havia busca pendente (ou ela falhou). */
  enqueued: number | null;
}

/**
 * A fila do worker. `tick()` é chamado a cada poucos segundos e nunca espera um run terminar:
 *
 * - se há uma busca horária pedida (`requestEnqueue`), enfileira; se falhar (banco fora do ar), o pedido
 *   continua de pé e a próxima verificação tenta de novo;
 * - encerra runs "running" abandonados (`reapStaleRuns`), nunca os que este processo está executando;
 * - inicia runs da fila: no máximo um por fonte ao mesmo tempo (os da mesma fonte rodam em sequência, sem
 *   martelar o site), fontes diferentes em paralelo até `maxConcurrent`, manuais antes dos horários.
 */
export function createQueue(db: Db, connectors: () => Connector[], opts: QueueOptions = {}) {
  const {
    maxConcurrent = 4,
    run: runOptions = {},
    staleAfterMs = maxSearchMs(runOptions) + STALE_MARGIN_MS,
    enqueue = () => enqueueAllActive(db),
    now = Date.now,
    log = () => {},
  } = opts;

  /** Runs em execução neste processo: id -> fonte. */
  const inFlight = new Map<number, string>();
  const running = new Set<Promise<void>>();
  let enqueueRequested = false;
  let ticking = false;

  function start(id: number, source: string) {
    inFlight.set(id, source);
    const done = executeRun(db, id, connectors(), runOptions).finally(() => {
      inFlight.delete(id);
      running.delete(done);
    });
    running.add(done);
  }

  async function tick(): Promise<TickResult> {
    const result: TickResult = { started: 0, reaped: 0, enqueued: null };
    if (ticking) return result; // a verificação anterior ainda está falando com o banco
    ticking = true;
    try {
      if (enqueueRequested) {
        try {
          result.enqueued = await enqueue();
          enqueueRequested = false;
        } catch (e) {
          log(`erro ao enfileirar a busca horária (nova tentativa na próxima verificação): ${errorText(e)}`);
        }
      }

      result.reaped = await reapStaleRuns(db, [...inFlight.keys()], now() - staleAfterMs);

      if (inFlight.size >= maxConcurrent) return result;
      const queued = await db
        .select({ id: runs.id, source: runs.source })
        .from(runs)
        .where(eq(runs.status, 'queued'))
        .orderBy(sql`(${runs.trigger} = 'manual') desc`, asc(runs.id));
      const busy = new Set(inFlight.values());
      for (const r of queued) {
        if (inFlight.size >= maxConcurrent) break;
        if (inFlight.has(r.id) || busy.has(r.source)) continue;
        busy.add(r.source);
        start(r.id, r.source);
        result.started++;
      }
      return result;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    /** Pede a busca horária: a próxima verificação enfileira (e insiste até conseguir). */
    requestEnqueue() {
      enqueueRequested = true;
    },
    /** Ids dos runs em execução neste processo. */
    inFlightIds: () => [...inFlight.keys()],
    /** Resolve quando os runs em execução neste momento terminarem. */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running]);
    },
    /** Verifica a fila repetidamente até não haver nada na fila nem em execução (testes e scripts). */
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

export type Queue = ReturnType<typeof createQueue>;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function msUntilNextHour(now: number = Date.now()): number {
  return HOUR - (now % HOUR);
}

/** Chama `fn` a cada hora cheia, para sempre. */
export function scheduleHourly(fn: () => void): void {
  setTimeout(() => {
    fn();
    scheduleHourly(fn);
  }, msUntilNextHour());
}
