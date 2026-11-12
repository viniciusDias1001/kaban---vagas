export interface RateLimiterOptions {
  /** Intervalo mínimo entre duas chamadas aceitas. */
  minIntervalMs: number;
  /** Máximo de chamadas aceitas dentro de `windowMs`. */
  max: number;
  windowMs: number;
  now?: () => number;
}

export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number };

export interface RateLimiter {
  /** Pede passagem. Uma chamada aceita conta, dê certo ou não o que vier depois. */
  take(): RateDecision;
}

/**
 * Limite de frequência em memória, por processo. Serve a um app de um usuário só, sem login: o limite é
 * global, não por cliente (não há como distinguir clientes, e um limite por IP seria contornável).
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { minIntervalMs, max, windowMs, now = Date.now } = opts;
  let accepted: number[] = [];
  return {
    take() {
      const t = now();
      accepted = accepted.filter((at) => t - at < windowMs);
      const last = accepted.at(-1);
      if (last !== undefined && t - last < minIntervalMs) return { ok: false, retryAfterMs: minIntervalMs - (t - last) };
      if (accepted.length >= max) return { ok: false, retryAfterMs: windowMs - (t - accepted[0]) };
      accepted.push(t);
      return { ok: true };
    },
  };
}
