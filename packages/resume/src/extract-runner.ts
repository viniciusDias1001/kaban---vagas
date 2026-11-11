import { Worker } from 'node:worker_threads';
import { EXTRACT_LIMITS, type ExtractResult } from './extract';
import type { ResumeKind } from './sniff';

export interface RunnerOptions {
  /** Tempo de leitura, contado a partir do aviso de "pronta" da worker. */
  timeoutMs?: number;
  maxMemoryMb?: number;
  /** Só nos testes: outro arquivo de entrada para a worker. */
  entry?: URL;
  /** Tempo para a worker subir (carregar os parsers) e avisar que está pronta. */
  startupTimeoutMs?: number;
  /** Crescimento máximo do RSS do processo durante a extração. */
  maxRssGrowthMb?: number;
}

/** Primeira mensagem da worker, enviada depois de carregar os imports. Qualquer outra mensagem é o resultado. */
export const WORKER_READY = { kvExtract: 'ready' } as const;

const MB = 1024 * 1024;
const RSS_POLL_MS = 100;
const unreadable: ExtractResult = { ok: false, reason: 'invalid', message: 'Não foi possível ler o arquivo.' };
const timedOut: ExtractResult = { ok: false, reason: 'timeout', message: 'O arquivo demorou demais para ser lido e foi recusado.' };
const tooMuchMemory: ExtractResult = { ok: false, reason: 'too_large', message: 'O arquivo ocupa memória demais para ser lido e foi recusado.' };

const isReady = (message: unknown) => (message as { kvExtract?: unknown } | null)?.kvExtract === WORKER_READY.kvExtract;
const isResult = (message: unknown): message is ExtractResult => typeof (message as { ok?: unknown } | null)?.ok === 'boolean';

function runWorker(buf: Uint8Array, kind: ResumeKind, opts: RunnerOptions): Promise<ExtractResult> {
  const {
    timeoutMs = EXTRACT_LIMITS.timeoutMs,
    maxMemoryMb = EXTRACT_LIMITS.maxMemoryMb,
    startupTimeoutMs = EXTRACT_LIMITS.startupTimeoutMs,
    maxRssGrowthMb = EXTRACT_LIMITS.maxRssGrowthMb,
    entry = new URL('./extract-worker.ts', import.meta.url),
  } = opts;
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(entry, { workerData: { buf, kind }, resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb } });
    } catch {
      return resolve(unreadable);
    }
    let done = false;
    const finish = (result: ExtractResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      // Só responde com a worker morta: a próxima da fila parte com a memória desta já devolvida.
      const settle = () => resolve(result);
      worker.terminate().then(settle, settle);
    };
    // Dois relógios: um para a worker subir, outro (armado no aviso de "pronta") para a leitura em si.
    let timer = setTimeout(() => finish(timedOut), startupTimeoutMs);
    // O teto de heap da worker não enxerga ArrayBuffers (é onde um stream compactado incha). O RSS é do
    // processo inteiro, mas só uma extração roda por vez: o que cresce além do teto é atribuído a ela.
    const baseline = process.memoryUsage.rss();
    const watchdog = setInterval(() => {
      if (process.memoryUsage.rss() - baseline > maxRssGrowthMb * MB) finish(tooMuchMemory);
    }, RSS_POLL_MS);
    worker.on('message', (message: unknown) => {
      if (done) return;
      if (isReady(message)) {
        clearTimeout(timer);
        timer = setTimeout(() => finish(timedOut), timeoutMs);
        return;
      }
      finish(isResult(message) ? message : unreadable);
    });
    // Inclui estouro de memória (ERR_WORKER_OUT_OF_MEMORY).
    worker.once('error', () => finish(unreadable));
    worker.once('exit', () => finish(unreadable));
  });
}

/** A extração em andamento (ou a última). Uma só por processo: as demais esperam por ela aqui. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Extrai o texto em uma worker thread com teto de tempo e de memória. Um arquivo que trava ou incha o
 * parser derruba só a worker (terminada aqui), nunca a thread que atende as requisições da API.
 *
 * Roda uma extração por vez no processo; chamadas simultâneas esperam em fila, e os relógios de cada
 * uma só começam quando chega a sua vez. Nunca rejeita.
 *
 * A entrada é um arquivo .ts: funciona porque API e worker rodam sob o tsx (`tsx src/index.ts` em dev,
 * `node --import tsx` em produção) e a worker herda os `execArgv` do processo.
 */
export function extractInWorker(buf: Uint8Array, kind: ResumeKind, opts: RunnerOptions = {}): Promise<ExtractResult> {
  const result = queue.then(() => runWorker(buf, kind, opts));
  queue = result;
  return result;
}
