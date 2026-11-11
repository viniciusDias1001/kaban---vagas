import { describe, expect, it } from 'vitest';
import { computePosition, dropPosition, isNoopMove } from './position';

const col = [
  { id: 1, position: 10 },
  { id: 2, position: 20 },
  { id: 3, position: 30 },
];

describe('computePosition', () => {
  it('returns 0 for an empty column', () => {
    expect(computePosition([], null)).toBe(0);
  });
  it('appends to the end when dropped on the column', () => {
    expect(computePosition(col, null)).toBe(31);
  });
  it('goes before the first card', () => {
    expect(computePosition(col, 1)).toBe(9);
  });
  it('goes between neighbours', () => {
    expect(computePosition(col, 2)).toBe(15);
    expect(computePosition(col, 3)).toBe(25);
  });
  it('appends when the target card is unknown', () => {
    expect(computePosition(col, 99)).toBe(31);
  });
});

describe('dropPosition', () => {
  // Coluna real: 1..6. Nos testes, um filtro mostra só parte dela, ou só a primeira página foi renderizada.
  const full = [1, 2, 3, 4, 5, 6].map((id) => ({ id, position: id * 10 }));
  const sorted = (moved: { id: number; position: number }) =>
    [...full.filter((c) => c.id !== moved.id), moved].sort((a, b) => a.position - b.position).map((c) => c.id);

  it('ignores the moved card when it is already in the column', () => {
    expect(dropPosition(full, 6, null)).toBe(51);
    expect(dropPosition(full, 1, 3)).toBe(25);
  });
  it('puts a card dropped before a visible card right before it, after the hidden card above', () => {
    // Visíveis com o filtro: 2, 4, 6. Soltar antes do 4 fica entre o 3 (escondido) e o 4.
    const position = dropPosition(full, 99, 4);
    expect(position).toBe(35);
    expect(sorted({ id: 99, position })).toEqual([1, 2, 3, 99, 4, 5, 6]);
  });
  it('puts a card dropped before the first visible card after the hidden cards above it', () => {
    const position = dropPosition(full, 99, 2);
    expect(sorted({ id: 99, position })).toEqual([1, 99, 2, 3, 4, 5, 6]);
  });
  it('puts a card dropped on a filtered column at the real end, not after the last visible card', () => {
    // Com um filtro que mostra só 1 e 2, a posição não pode ser 21 (cairia antes do 3, escondido).
    const position = dropPosition(full, 99, null);
    expect(position).toBe(61);
    expect(sorted({ id: 99, position })).toEqual([1, 2, 3, 4, 5, 6, 99]);
  });
  it('puts a card dropped on a partially rendered column at the real end', () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, position: i }));
    // Só os 60 primeiros estão na tela; o fim de verdade é depois do card 500.
    expect(dropPosition(big, 7, null)).toBe(500);
    expect(dropPosition(big, 999, 60)).toBe(58.5);
  });
  it('never ties with a neighbour when positions are distinct', () => {
    for (const before of [1, 2, 3, 4, 5, 6]) {
      const position = dropPosition(full, 99, before);
      expect(full.some((c) => c.position === position)).toBe(false);
    }
  });
  it('moves within the same column relative to the other cards', () => {
    const position = dropPosition(full, 5, 2);
    expect(sorted({ id: 5, position })).toEqual([1, 5, 2, 3, 4, 6]);
  });
});

describe('isNoopMove', () => {
  it('is true when the card is already right before the target, or already last', () => {
    expect(isNoopMove(col, 1, 2)).toBe(true);
    expect(isNoopMove(col, 3, null)).toBe(true);
  });
  it('is false for a real move or a card coming from another column', () => {
    expect(isNoopMove(col, 1, 3)).toBe(false);
    expect(isNoopMove(col, 1, null)).toBe(false);
    expect(isNoopMove(col, 99, null)).toBe(false);
    expect(isNoopMove([], 99, null)).toBe(false);
  });
});
