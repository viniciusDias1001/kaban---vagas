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

/**
 * Posição de um card solto, calculada sobre a coluna REAL: `fullColumn` são todos os cards da coluna de
 * destino em ordem, inclusive os que o filtro esconde e os que ainda não foram renderizados ("Mostrar
 * mais"). Soltar antes do card X põe o card imediatamente antes de X na ordem real (entre X e o vizinho
 * de cima dele, visível ou não); soltar na coluna (`beforeId` null) põe no fim de verdade.
 */
export function dropPosition(fullColumn: Positioned[], movedId: number, beforeId: number | null): number {
  return computePosition(fullColumn.filter((c) => c.id !== movedId), beforeId);
}

/**
 * Verdadeiro quando soltar o card ali não muda nada: ele já está imediatamente antes de `beforeId` (ou já
 * é o último, com `beforeId` null) na coluna de destino. Evita um PATCH (e um refetch) à toa.
 */
export function isNoopMove(fullColumn: Positioned[], movedId: number, beforeId: number | null): boolean {
  const index = fullColumn.findIndex((c) => c.id === movedId);
  if (index === -1) return false;
  return (fullColumn[index + 1]?.id ?? null) === beforeId;
}
