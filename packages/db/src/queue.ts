import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { runs, type RunTrigger } from './schema';

/** Enfileira um run por fonte do perfil; ignora fontes que já têm run pendente. Devolve quantos enfileirou. */
export function enqueueRuns(db: Db, profile: { id: number; sources: string[] }, trigger: RunTrigger): number {
  const pending = db
    .select({ source: runs.source })
    .from(runs)
    .where(and(eq(runs.profileId, profile.id), inArray(runs.status, ['queued', 'running'])))
    .all()
    .map((r) => r.source);
  const todo = profile.sources.filter((s) => !pending.includes(s));
  for (const source of todo) {
    db.insert(runs).values({ profileId: profile.id, source, trigger, status: 'queued', createdAt: Date.now() }).run();
  }
  return todo.length;
}
