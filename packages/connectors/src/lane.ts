import { sleep as realSleep } from './http';

/**
 * Faixa de cortesia de um site: uma requisição de cada vez, com um intervalo mínimo entre o fim de uma e o
 * começo da seguinte. Quem divide a mesma faixa não se sobrepõe: a busca de vagas do LinkedIn e a busca da
 * descrição de uma vaga usam `linkedinLane`, então um detalhe pedido no meio da busca de hora em hora
 * espera a requisição em curso terminar (e a busca espera o detalhe).
 */
export interface Lane {
  /** Roda `work` quando chegar a vez. O resultado (ou o erro) de `work` é o desta chamada. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface LaneOptions {
  /** Intervalo mínimo entre o fim de uma requisição e o começo da seguinte. 0 = só não sobrepor. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Intervalo entre requisições ao LinkedIn (o mesmo da pausa entre as consultas da busca). */
export const LINKEDIN_MIN_INTERVAL_MS = 1_500;

export function createLane(options: LaneOptions = {}): Lane {
  const { minIntervalMs = 0, sleep = realSleep, now = Date.now } = options;
  let tail: Promise<void> = Promise.resolve();
  /** Fim da última requisição; null enquanto nenhuma rodou (a primeira não espera). */
  let last: number | null = null;
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        if (last !== null) {
          const wait = last + minIntervalMs - now();
          if (wait > 0) await sleep(wait);
        }
        try {
          return await work();
        } finally {
          last = now();
        }
      });
      // A fila anda mesmo quando esta requisição (ou a espera dela) falha: o erro vai só para quem chamou.
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}

/**
 * A faixa do LinkedIn neste processo, dividida pelo conector de busca (`linkedin`) e pela busca de descrição
 * (`fetchJobDescription`). Vale por processo: a API e o worker são processos diferentes, mas só o worker
 * fala com o LinkedIn.
 */
export const linkedinLane: Lane = createLane({ minIntervalMs: LINKEDIN_MIN_INTERVAL_MS });
