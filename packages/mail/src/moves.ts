import type { Actor, Column, DecisiveKind } from '@kv/shared';

export interface MoveState {
  column: Column;
  lastMove: { actor: Actor; at: number } | null;
  lastDecisiveMailAt: number | null;
}

/** A coluna para onde o e-mail leva o card, ou null se ele fica onde está. */
export function decideMove(kind: DecisiveKind, mailDate: number, state: MoveState): Column | null {
  // Um e-mail mais antigo que o último decisivo, ou que o último movimento do dono, só é registrado.
  if (state.lastDecisiveMailAt !== null && mailDate < state.lastDecisiveMailAt) return null;
  const byOwner = state.lastMove?.actor === 'humano';
  if (byOwner && mailDate < state.lastMove!.at) return null;
  if (state.column === 'arquivada') return null;
  if (state.column === 'perdida' && byOwner) return null;

  const column: Column = state.column === 'descobertas' || state.column === 'selecionadas' ? 'aplicada' : state.column;
  switch (kind) {
    case 'reprovacao':
      return column === 'perdida' ? null : 'perdida';
    case 'entrevista':
      return column === 'entrevista' || column === 'oferta' ? null : 'entrevista';
    case 'oferta':
      return column === 'oferta' ? null : 'oferta';
  }
}
