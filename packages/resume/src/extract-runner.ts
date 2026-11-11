import { Worker } from 'node:worker_threads';
import { EXTRACT_LIMITS, type ExtractResult } from './extract';
import type { ResumeKind } from './sniff';

export interface RunnerOptions {
  timeoutMs?: number;
  maxMemoryMb?: number;
  /** Só nos testes: outro arquivo de entrada para a worker. */
  entry?: URL;
}

/**
 * Extrai o texto em uma worker thread com teto de tempo e de memória. Um arquivo que trava ou incha o
 * parser derruba só a worker (terminada aqui), nunca a thread que atende as requisições da API.
 *
 * A entrada é um arquivo .ts: funciona porque API e worker rodam sob o tsx (`tsx src/index.ts` em dev,
 * `node --import tsx` em produção) e a worker herda os `execArgv` do processo.
 */
export function extractInWorker(buf: Uint8Array, kind: ResumeKind, opts: RunnerOptions = {}): Promise<ExtractResult> {
  const {
    timeoutMs = EXTRACT_LIMITS.timeoutMs,
    maxMemoryMb = EXTRACT_LIMITS.maxMemoryMb,
    entry = new URL('./extract-worker.ts', import.meta.url),
  } = opts;
  return new Promise((resolve) => {
    const worker = new Worker(entry, { workerData: { buf, kind }, resourceLimits: { maxOldGenerationSizeMb: maxMemoryMb } });
    let done = false;
    const finish = (result: ExtractResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout', message: 'O arquivo demorou demais para ser lido e foi recusado.' }),
      timeoutMs,
    );
    worker.once('message', (result: ExtractResult) => finish(result));
    // Inclui estouro de memória (ERR_WORKER_OUT_OF_MEMORY).
    worker.once('error', () => finish({ ok: false, reason: 'invalid', message: 'Não foi possível ler o arquivo.' }));
    worker.once('exit', () => finish({ ok: false, reason: 'invalid', message: 'Não foi possível ler o arquivo.' }));
  });
}
