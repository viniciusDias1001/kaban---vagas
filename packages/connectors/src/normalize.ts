import { NormalizedJobSchema, type NormalizedJob, type SearchFilters } from '@kv/shared';
import { detectStacks } from './filter';

/** Descarta vagas que não passam no schema (ex.: sem empresa ou sem URL válida). */
export function keepValid(jobs: NormalizedJob[]): NormalizedJob[] {
  return jobs.filter((j) => NormalizedJobSchema.safeParse(j).success);
}

/** Converte data ISO, epoch em segundos ou epoch em ms para epoch em ms. */
export function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Termos de busca enviados às fontes que aceitam palavra-chave. */
export function queriesFor(filters: SearchFilters): string[] {
  return filters.stacks.length > 0 ? filters.stacks.slice(0, 3) : ['developer'];
}

/**
 * Stacks detectadas no texto. `query` (o termo que originou a busca) só deve ser passado por fontes
 * que não trazem descrição (LinkedIn, Indeed): nas demais ele anularia o filtro de stacks.
 */
export function stacksWithQuery(text: string, query?: string): string[] {
  const found = detectStacks(text);
  if (query && query !== 'developer' && !found.includes(query.toLowerCase())) found.push(query.toLowerCase());
  return found;
}
