import { NormalizedJobSchema, type NormalizedJob, type SearchFilters } from '@kv/shared';
import { detectStacks } from './filter';
import { canonicalTerm } from './text';

/** Descarta vagas que não passam no schema (ex.: sem empresa ou sem URL válida). */
export function keepValid(jobs: NormalizedJob[]): NormalizedJob[] {
  return jobs.filter((j) => NormalizedJobSchema.safeParse(j).success);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_NO_ZONE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * Converte data ISO, epoch em segundos ou epoch em ms para epoch em ms.
 * Data sem hora vale como o fim daquele dia (UTC), para não envelhecer a vaga em até um dia;
 * data e hora sem fuso valem como UTC, e não como a hora local da máquina.
 */
export function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const text = value.trim();
  const noZone = DATE_TIME_NO_ZONE.exec(text);
  const iso = DATE_ONLY.test(text) ? `${text}T23:59:59.999Z` : noZone ? `${noZone[1]}T${noZone[2]}Z` : text;
  const ms = Date.parse(iso);
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
  const term = query ? canonicalTerm(query) : '';
  if (term && term !== 'developer' && !found.includes(term)) found.push(term);
  return found;
}
