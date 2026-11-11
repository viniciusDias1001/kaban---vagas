import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  AI_LAYERS, type AiLayer, type AiTaskDto, type AiTaskType, type CandidateProfile, type ProfileOrigin,
  type ResumeLang, type UsageByLayer,
} from '@kv/shared';
import type { Db } from './client';
import { aiTasks, aiUsage, candidateProfiles } from './schema';

export type AiTaskRow = typeof aiTasks.$inferSelect;
export type CandidateProfileRow = typeof candidateProfiles.$inferSelect;

export type AiTaskTarget =
  | { type: 'tier1' | 'tier2' | 'tier3'; jobId: number }
  | { type: 'profile_extract' | 'profile_translate'; lang: ResumeLang };

export const jobSubject = (jobId: number) => `job:${jobId}`;
export const langSubject = (lang: ResumeLang) => `lang:${lang}`;

/** Estados em que a tarefa ainda vai rodar (os do índice único parcial `ai_tasks_pending_idx`). */
export const AI_PENDING = ['queued', 'running', 'blocked_budget'] as const;

/**
 * Enfileira uma tarefa de IA. Devolve o id, ou null se já existe uma pendente para o mesmo tipo e alvo
 * (índice único parcial + ON CONFLICT DO NOTHING, como `enqueueRuns`).
 */
export async function enqueueAiTask(db: Db, target: AiTaskTarget, now: number = Date.now()): Promise<number | null> {
  const values =
    'jobId' in target
      ? { type: target.type, subject: jobSubject(target.jobId), jobId: target.jobId }
      : { type: target.type, subject: langSubject(target.lang), lang: target.lang };
  const [row] = await db
    .insert(aiTasks)
    .values({ ...values, status: 'queued', createdAt: now })
    .onConflictDoNothing()
    .returning({ id: aiTasks.id });
  return row?.id ?? null;
}

/** O usuário aceitou gastar acima do limite: a tarefa bloqueada volta para a fila, marcada. */
export async function confirmAiTask(db: Db, id: number): Promise<boolean> {
  const rows = await db
    .update(aiTasks)
    .set({ status: 'queued', confirmed: true, runAfter: null })
    .where(and(eq(aiTasks.id, id), eq(aiTasks.status, 'blocked_budget')))
    .returning({ id: aiTasks.id });
  return rows.length > 0;
}

export const toAiTaskDto = (t: AiTaskRow): AiTaskDto => ({
  id: t.id, type: t.type, status: t.status, attempts: t.attempts, error: t.error, jobId: t.jobId, lang: t.lang,
  createdAt: t.createdAt, finishedAt: t.finishedAt,
});

/** A tarefa mais recente de cada tipo pedido para um alvo. */
export async function latestAiTasks(db: Db, subject: string, types: AiTaskType[]): Promise<Map<AiTaskType, AiTaskRow>> {
  const rows = await db
    .select()
    .from(aiTasks)
    .where(and(eq(aiTasks.subject, subject), inArray(aiTasks.type, types)))
    .orderBy(desc(aiTasks.id));
  const latest = new Map<AiTaskType, AiTaskRow>();
  for (const row of rows) if (!latest.has(row.type)) latest.set(row.type, row);
  return latest;
}

export async function profileFor(db: Db, lang: ResumeLang): Promise<CandidateProfileRow | null> {
  const [row] = await db.select().from(candidateProfiles).where(eq(candidateProfiles.lang, lang));
  return row ?? null;
}

/** O perfil usado nas camadas 1 e 2: pt-BR se existir, senão inglês. */
export async function baseProfile(db: Db): Promise<CandidateProfileRow | null> {
  return (await profileFor(db, 'pt-BR')) ?? (await profileFor(db, 'en'));
}

/**
 * Grava (cria ou substitui) o perfil de um idioma com a próxima versão global. Tudo que foi calculado
 * com uma versão anterior passa a contar como desatualizado.
 */
export async function saveProfile(
  db: Db,
  lang: ResumeLang,
  data: CandidateProfile,
  origin: ProfileOrigin,
  now: number = Date.now(),
): Promise<CandidateProfileRow> {
  return db.transaction(async (tx) => {
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${candidateProfiles.version}), 0)::int + 1`.mapWith(Number) })
      .from(candidateProfiles);
    const [row] = await tx
      .insert(candidateProfiles)
      .values({ lang, data, origin, version: next, updatedAt: now })
      .onConflictDoUpdate({ target: candidateProfiles.lang, set: { data, origin, version: next, updatedAt: now } })
      .returning();
    return row;
  });
}

export async function recordUsage(db: Db, usage: Omit<typeof aiUsage.$inferInsert, 'id'>): Promise<void> {
  await db.insert(aiUsage).values(usage);
}

/** Custo estimado (US$) desde `since`. */
export async function aiSpentSince(db: Db, since: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float8`.mapWith(Number) })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, since));
  return row.total;
}

export async function usageByLayer(db: Db, since: number): Promise<UsageByLayer> {
  const rows = await db
    .select({ layer: aiUsage.layer, total: sql<number>`sum(${aiUsage.costUsd})::float8`.mapWith(Number) })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, since))
    .groupBy(aiUsage.layer);
  const out = Object.fromEntries(AI_LAYERS.map((l) => [l, 0])) as UsageByLayer;
  for (const row of rows) out[row.layer as AiLayer] = row.total;
  return out;
}
