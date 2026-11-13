import type { Actor, Column } from '@kv/shared';
import { describe, expect, it } from 'vitest';
import { decideMove, type MoveState } from './moves';

const st = (column: Column, actor: Actor = 'ia', at = 100, lastDecisiveMailAt: number | null = null): MoveState => ({ column, lastMove: { actor, at }, lastDecisiveMailAt });

describe('decideMove', () => {
  it.each([
    ['entrevista', st('aplicada'), 'entrevista'], ['entrevista', st('entrevista'), null], ['entrevista', st('oferta'), null],
    ['entrevista', st('perdida', 'email'), 'entrevista'], ['entrevista', st('perdida', 'humano'), null], ['entrevista', st('arquivada', 'humano'), null],
    ['oferta', st('aplicada'), 'oferta'], ['oferta', st('entrevista'), 'oferta'], ['oferta', st('oferta'), null],
    ['oferta', st('perdida', 'email'), 'oferta'], ['oferta', st('perdida', 'humano'), null], ['oferta', st('arquivada', 'email'), null],
    ['reprovacao', st('aplicada'), 'perdida'], ['reprovacao', st('entrevista'), 'perdida'], ['reprovacao', st('oferta'), 'perdida'],
    ['reprovacao', st('perdida', 'email'), null], ['reprovacao', st('arquivada', 'humano'), null], ['reprovacao', st('selecionadas'), 'perdida'],
    ['entrevista', st('descobertas'), 'entrevista'], ['oferta', st('selecionadas'), 'oferta'], ['reprovacao', st('descobertas'), 'perdida'],
  ] as const)('%s on %o -> %s', (kind, state, to) => {
    expect(decideMove(kind, 500, state)).toBe(to);
  });

  it('never moves an archived card, whoever archived it', () => {
    expect(decideMove('oferta', 500, st('arquivada', 'sistema'))).toBeNull();
    expect(decideMove('entrevista', 500, st('arquivada', 'ia'))).toBeNull();
  });

  it('an older rejection read later does not undo an interview', () => {
    expect(decideMove('reprovacao', 200, st('entrevista', 'email', 900, 300))).toBeNull();
  });

  it('a mail as old as the last decisive mail still counts', () => {
    expect(decideMove('reprovacao', 300, st('entrevista', 'email', 900, 300))).toBe('perdida');
  });

  it('a mail older than the owner last move only gets recorded', () => {
    expect(decideMove('reprovacao', 200, st('entrevista', 'humano', 300))).toBeNull();
    expect(decideMove('reprovacao', 400, st('entrevista', 'humano', 300))).toBe('perdida');
  });

  it('an older last move by a machine does not block', () => {
    expect(decideMove('reprovacao', 200, st('entrevista', 'ia', 300))).toBe('perdida');
  });

  it('works with no recorded move', () => {
    expect(decideMove('entrevista', 500, { column: 'aplicada', lastMove: null, lastDecisiveMailAt: null })).toBe('entrevista');
    expect(decideMove('entrevista', 500, { column: 'perdida', lastMove: null, lastDecisiveMailAt: null })).toBe('entrevista');
  });
});
