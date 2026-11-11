import { describe, expect, it } from 'vitest';
import { computePosition } from './position';

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
