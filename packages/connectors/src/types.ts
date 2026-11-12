import type { NormalizedJob, SearchFilters } from '@kv/shared';

/**
 * Configuração que o worker entrega a cada busca. Vem do serviço de configurações (aba Configurações);
 * os conectores não conhecem o banco. Ausente (testes, scripts), cada conector usa a variável de
 * ambiente e o padrão de sempre.
 */
export interface ConnectorConfig {
  greenhouseBoards?: readonly string[];
  leverCompanies?: readonly string[];
}

export interface Connector {
  id: string;
  name: string;
  /**
   * `signal` é abortado pelo worker quando a busca estoura o timeout: quem o repassa às requisições
   * (ver `fetchText`/`fetchJson`) as cancela de verdade. Conectores que o ignoram continuam válidos.
   */
  search(filters: SearchFilters, signal?: AbortSignal, config?: ConnectorConfig): Promise<NormalizedJob[]>;
}
