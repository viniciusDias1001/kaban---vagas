export const STALE_AFTER_MS = 2 * 3_600_000;

export interface WorkerStaleInput {
  now: number;
  /** Fim do último run concluído (ok ou erro); null se nenhum terminou ainda. */
  lastFinishedAt: number | null;
  profiles: readonly { active: boolean; createdAt: number }[];
}

/**
 * O aviso "o worker parou" só faz sentido se há trabalho para ele: pelo menos um perfil ativo. Com isso,
 * o worker está atrasado quando o último run concluído tem mais de 2 h ou, se nenhum run terminou até
 * hoje, quando o perfil ativo mais antigo já existe há mais de 2 h.
 */
export function isWorkerStale({ now, lastFinishedAt, profiles }: WorkerStaleInput): boolean {
  const active = profiles.filter((p) => p.active);
  if (active.length === 0) return false;
  if (lastFinishedAt !== null) return now - lastFinishedAt > STALE_AFTER_MS;
  const oldest = Math.min(...active.map((p) => p.createdAt));
  return now - oldest > STALE_AFTER_MS;
}
