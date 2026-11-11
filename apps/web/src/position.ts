export interface Positioned {
  id: number;
  position: number;
}

/**
 * Posição de um card solto em uma coluna.
 * `column`: cards da coluna em ordem crescente, sem o card arrastado.
 * `beforeId`: card antes do qual soltar; null = fim da coluna.
 */
export function computePosition(column: Positioned[], beforeId: number | null): number {
  if (column.length === 0) return 0;
  const last = column[column.length - 1].position;
  if (beforeId === null) return last + 1;
  const i = column.findIndex((c) => c.id === beforeId);
  if (i === -1) return last + 1;
  if (i === 0) return column[0].position - 1;
  return (column[i - 1].position + column[i].position) / 2;
}
