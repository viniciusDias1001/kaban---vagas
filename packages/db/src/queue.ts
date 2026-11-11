import type { Db } from './client';
import { runs, type RunTrigger } from './schema';

/**
 * Enfileira um run por fonte do perfil; ignora fontes que já têm run pendente. Devolve quantos enfileirou.
 * Atômico: o índice único parcial `runs_pending_idx` + ON CONFLICT DO NOTHING impede duplicatas mesmo com
 * API e worker enfileirando ao mesmo tempo, e a transação torna o conjunto tudo-ou-nada.
 */
export async function enqueueRuns(
  db: Db,
  profile: { id: number; sources: string[] },
  trigger: RunTrigger,
): Promise<number> {
  const sources = [...new Set(profile.sources)];
  if (sources.length === 0) return 0;
  const createdAt = Date.now();
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(runs)
      .values(sources.map((source) => ({ profileId: profile.id, source, trigger, status: 'queued' as const, createdAt })))
      .onConflictDoNothing()
      .returning({ id: runs.id });
    return inserted.length;
  });
}
