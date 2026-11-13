import type { Column } from '@kv/shared/client';

/** Cor de identidade de cada coluna (definidas em index.css). */
export const COLUMN_COLOR: Record<Column, string> = {
  descobertas: 'var(--col-descobertas)',
  selecionadas: 'var(--col-selecionadas)',
  aplicada: 'var(--col-aplicada)',
  entrevista: 'var(--col-entrevista)',
  oferta: 'var(--col-oferta)',
  perdida: 'var(--col-perdida)',
  arquivada: 'var(--col-arquivada)',
};
