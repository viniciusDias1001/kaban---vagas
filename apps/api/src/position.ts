/**
 * Onde o cliente quis soltar o card quando a posição pedida (`requested`) é igual à de um vizinho.
 *
 * O quadro calcula a posição como o ponto médio dos dois vizinhos; quando não há mais número de ponto
 * flutuante entre eles, o ponto médio "cai" em cima de um dos dois. `sorted` são as posições dos outros
 * cards da coluna, em ordem crescente. Devolve o índice em que o card movido deve entrar nessa lista.
 */
export function intendedIndex(sorted: readonly number[], requested: number): number {
  const first = sorted.indexOf(requested);
  if (first === -1) return sorted.filter((p) => p < requested).length;
  const last = sorted.lastIndexOf(requested);
  // Vários cards já empatados nessa posição: o ponto médio entre dois deles é a própria posição.
  if (last > first) return first + 1;
  const next = sorted[last + 1];
  // Ponto médio entre este vizinho e o de baixo caiu neste: o card ia logo depois dele.
  if (next !== undefined && (requested + next) / 2 === requested) return last + 1;
  const previous = sorted[first - 1];
  // Ponto médio entre o vizinho de cima e este caiu neste: o card ia logo antes dele.
  if (previous !== undefined && (previous + requested) / 2 === requested) return first;
  return last + 1;
}
