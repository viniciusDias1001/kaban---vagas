import type { NormalizedJob, SearchFilters } from '@kv/shared';

export interface Connector {
  id: string;
  name: string;
  /**
   * `signal` é abortado pelo worker quando a busca estoura o timeout: quem o repassa às requisições
   * (ver `fetchText`/`fetchJson`) as cancela de verdade. Conectores que o ignoram continuam válidos.
   */
  search(filters: SearchFilters, signal?: AbortSignal): Promise<NormalizedJob[]>;
}
