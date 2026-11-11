import type { Db } from './client';
import { runs, type RunTrigger } from './schema';

/**
 * Enfileira um run por fonte do perfil; ignora fontes que já têm run pendente. Devolve quantos enfileirou.
 * Atômico: o índice único parcial `runs_pending_idx` + ON CONFLICT DO NOTHING impede duplicatas mesmo com
 * API e worker enfileirando ao mesmo tempo, e a transação IMMEDIATE torna o conjunto tudo-ou-nada.
 */
export function enqueueRuns(db: Db, profile: { id: number; sources: string[] }, trigger: RunTrigger): number {
  return db.transaction(
    (tx) => {
      let queued = 0;
      for (const source of new Set(profile.sources)) {
        const res = tx
          .insert(runs)
          .values({ profileId: profile.id, source, trigger, status: 'queued', createdAt: Date.now() })
          .onConflictDoNothing()
          .run();
        queued += res.changes;
      }
      return queued;
    },
    { behavior: 'immediate' },
  );
}
