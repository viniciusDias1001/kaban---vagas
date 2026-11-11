export interface CollectOptions {
  /** Espera entre uma consulta e a seguinte (nunca antes da primeira nem depois da última). */
  pause?: () => Promise<void>;
  /** Consultado antes de cada consulta; quando devolve true, as restantes não são feitas. */
  shouldStop?: () => boolean;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Roda as consultas de uma fonte em sequência e junta os resultados. Uma consulta que falha não descarta
 * o que as outras trouxeram: só lança se todas as consultas feitas falharam.
 */
export async function collectQueries<Q, R>(
  source: string,
  queries: readonly Q[],
  run: (query: Q) => Promise<R[]>,
  options: CollectOptions = {},
): Promise<R[]> {
  const out: R[] = [];
  const errors: unknown[] = [];
  let attempted = 0;
  for (const query of queries) {
    if (options.shouldStop?.()) break;
    if (attempted > 0) await options.pause?.();
    attempted++;
    try {
      out.push(...(await run(query)));
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length === 0) return out;
  if (errors.length === attempted) {
    if (attempted === 1) throw errors[0];
    throw new Error(`${source}: as ${attempted} consultas falharam — ${message(errors[0])}`, { cause: errors[0] });
  }
  console.warn(`${source}: ${errors.length} de ${attempted} consultas falharam — ${message(errors[0])}`);
  return out;
}
