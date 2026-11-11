/**
 * Constantes, tipos e helpers puros de `@kv/shared`, sem dependência de Zod. É o que o navegador usa
 * (via `@kv/shared/client`); os schemas de validação moram em `schemas.ts` e usam estes valores.
 */

export const COLUMNS = ['descobertas', 'selecionadas', 'aplicada', 'entrevista', 'oferta', 'arquivada'] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  descobertas: 'Descobertas',
  selecionadas: 'Selecionadas',
  aplicada: 'Aplicada',
  entrevista: 'Entrevista',
  oferta: 'Oferta',
  arquivada: 'Arquivada',
};

export const LEVELS = ['junior', 'pleno', 'senior'] as const;
export type Level = (typeof LEVELS)[number];

export const REGIONS = ['brasil', 'exterior', 'remoto'] as const;
export type Region = (typeof REGIONS)[number];

export const MAX_AGES = [1, 3, 7, 30] as const;
export type MaxAge = (typeof MAX_AGES)[number];

/** Limites de tamanho dos campos de texto livre (a API responde 400 acima deles). */
export const LIMITS = {
  profileName: 80,
  stackLength: 40,
  stacks: 20,
  sourceIdLength: 40,
  sources: 50,
  notes: 20_000,
  search: 100,
} as const;

/** O Postgres não aceita o caractere NUL em `text`: barrado na validação, em vez de virar erro 500. */
export const hasNul = (s: string) => s.includes('\u0000');
