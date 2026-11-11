import type { NormalizedJob, SearchFilters } from '@kv/shared';

export interface Connector {
  id: string;
  name: string;
  search(filters: SearchFilters): Promise<NormalizedJob[]>;
}
