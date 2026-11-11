import { describe, expect, it } from 'vitest';
import { intendedIndex } from './position';

/** O próximo double depois de `x` (x > 0). */
const nextUp = (x: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
};

describe('intendedIndex', () => {
  it('counts the smaller positions when there is no collision', () => {
    expect(intendedIndex([], 5)).toBe(0);
    expect(intendedIndex([1, 2, 3], 2.5)).toBe(2);
    expect(intendedIndex([1, 2, 3], 0)).toBe(0);
    expect(intendedIndex([1, 2, 3], 9)).toBe(3);
  });

  it('goes after the neighbour when the midpoint with the next card collapsed onto it', () => {
    const a = 1;
    const b = nextUp(a);
    expect((a + b) / 2).toBe(a); // não há double entre os dois
    expect(intendedIndex([0, a, b, 7], a)).toBe(2);
  });

  it('goes before the neighbour when the midpoint with the previous card collapsed onto it', () => {
    const a = nextUp(1);
    const b = nextUp(a);
    expect((a + b) / 2).toBe(b);
    expect(intendedIndex([0, a, b, 7], b)).toBe(2);
  });

  it('goes between two cards that already share the position', () => {
    expect(intendedIndex([0, 3, 3, 7], 3)).toBe(2);
  });

  it('goes right after the neighbour when nothing explains the collision', () => {
    expect(intendedIndex([1, 2, 3], 2)).toBe(2);
    expect(intendedIndex([2], 2)).toBe(1);
  });
});
