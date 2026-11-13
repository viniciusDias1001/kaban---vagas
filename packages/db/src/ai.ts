import { and, desc, eq, gt, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import {
  AI_LAYERS, otherLang, type AiLayer, type AiTaskDto, type AiTaskType, type CandidateProfile, type ProfileOrigin,
  type ResumeLang, type UsageByLayer,
} from '@kv/shared';
import { deleteApplyData } from './apply';
import type { Db } from './client';
import { aiTasks, aiUsage, candidateProfiles, jobAi, resumes, tailoredResumes } from './schema';

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

/**
 * Tarefas da camada 1 em espera porque o PROVEDOR está indisponível (chave recusada, sem crédito, modelo
 * inexistente, limite de taxa que não passa). A fila as devolve com `attempts = 0`, o erro do provedor e um
 * `run_after` distante, e é só nesse caso que uma tarefa na fila tem erro sem ter tentativa contada: uma tarefa que
 * nunca rodou não tem erro, e a que espera uma nova tentativa comum tem `attempts >= 1`.
 */
const PROVIDER_WAIT = and(eq(aiTasks.type, 'tier1'), eq(aiTasks.attempts, 0), isNotNull(aiTasks.error));

export interface ProviderWait {
  /** O erro do provedor (frase fixa do adaptador; nunca contém a chave). */
  message: string;
  /** Quando a fila tenta de novo sozinha. */
  retryAt: number;
  /** Quantas tarefas estão esperando. */
  tasks: number;
}

/** A triagem está em pausa por indisponibilidade do provedor? Devolve o motivo e a hora da próxima tentativa. */
export async function providerWait(db: Db, now: number = Date.now()): Promise<ProviderWait | null> {
  const [row] = await db
    .select({
      tasks: sql<number>`count(*)::int`.mapWith(Number),
      retryAt: sql<number | null>`min(${aiTasks.runAfter})`.mapWith(aiTasks.runAfter),
      message: sql<string | null>`max(${aiTasks.error})`,
    })
    .from(aiTasks)
    .where(and(PROVIDER_WAIT, inArray(aiTasks.status, ['queued', 'blocked_budget']), gt(aiTasks.runAfter, now)));
  if (!row || row.tasks === 0 || row.retryAt === null) return null;
  return { message: row.message ?? '', retryAt: row.retryAt, tasks: row.tasks };
}

/**
 * Libera as tarefas em espera pelo provedor para rodarem já. Chamado quando o usuário mexe na configuração de IA
 * (chave gravada, provedor ou modelo trocado, "Testar conexão" bem-sucedido): não faz sentido esperar a pausa
 * acabar depois que o problema foi corrigido. Devolve quantas liberou.
 */
export async function resumeProviderWaits(db: Db): Promise<number> {
  const rows = await db
    .update(aiTasks)
    .set({ runAfter: null, error: null })
    .where(and(PROVIDER_WAIT, inArray(aiTasks.status, ['queued', 'blocked_budget'])))
    .returning({ id: aiTasks.id });
  return rows.length;
}

/** Apaga as tarefas TERMINADAS (ok ou erro) antes de `finishedBefore`. Devolve quantas apagou. */
export async function pruneAiTasks(db: Db, finishedBefore: number): Promise<number> {
  const rows = await db
    .delete(aiTasks)
    .where(and(inArray(aiTasks.status, ['ok', 'error']), lt(aiTasks.finishedAt, finishedBefore)))
    .returning({ id: aiTasks.id });
  return rows.length;
}

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
 * Chave (arbitrária, fixa) do advisory lock que serializa as gravações de perfil. Diferente de
 * `JOBS_WRITE_LOCK`: gravar um perfil não espera a inserção de vagas, nem o contrário.
 */
export const PROFILE_VERSION_LOCK = 7461002;

/** O perfil no banco não é mais o que quem está gravando leu (`ifVersion` de `saveProfile`). */
export class ProfileConflictError extends Error {
  override name = 'ProfileConflictError';
  constructor(
    readonly lang: ResumeLang,
    readonly expectedVersion: number,
    /** Versão que está no banco agora; null se o perfil foi apagado. */
    readonly currentVersion: number | null,
  ) {
    super(`o perfil ${lang} mudou: esperava a versão ${expectedVersion}, o banco tem ${currentVersion ?? 'nenhuma'}`);
  }
}

export interface SaveProfileOptions {
  /** Só grava se o perfil do idioma ainda estiver nesta versão; senão lança `ProfileConflictError`. */
  ifVersion?: number;
  /**
   * Chamado DENTRO do lock de gravação, com o perfil atual do idioma (ou null): lançar aqui cancela a gravação.
   * É como uma tarefa do worker evita sobrescrever um perfil que o usuário editou enquanto ela rodava.
   */
  guard?: (current: CandidateProfileRow | null, tx: Db) => Promise<void> | void;
}

/**
 * Grava (cria ou substitui) o perfil de um idioma com a próxima versão global. Tudo que foi calculado
 * com uma versão anterior passa a contar como desatualizado.
 *
 * Ler `max(version)` e gravar `max + 1` não é atômico em READ COMMITTED: a edição pela API e a tradução
 * do worker poderiam ler o mesmo máximo e gravar a mesma versão. O advisory lock de transação faz a
 * segunda gravação esperar o commit da primeira; como cada comando em READ COMMITTED enxerga o que já
 * foi confirmado, o `max(version)` lido depois do lock já inclui a gravação anterior.
 */
export async function saveProfile(
  db: Db,
  lang: ResumeLang,
  data: CandidateProfile,
  origin: ProfileOrigin,
  now: number = Date.now(),
  opts: SaveProfileOptions = {},
): Promise<CandidateProfileRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(PROFILE_VERSION_LOCK))})`);
    if (opts.ifVersion !== undefined || opts.guard) {
      // Dentro do lock: o que for lido aqui é o que a gravação abaixo vai substituir.
      const [current] = await tx.select().from(candidateProfiles).where(eq(candidateProfiles.lang, lang));
      if (opts.ifVersion !== undefined && current?.version !== opts.ifVersion) {
        throw new ProfileConflictError(lang, opts.ifVersion, current?.version ?? null);
      }
      await opts.guard?.(current ?? null, tx);
    }
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

/**
 * Sufixo do `model` de uma linha de `ai_usage` cujos tokens são ESTIMADOS (chamada abortada por tempo ou
 * interrompida pela queda do processo: o provedor não informou o uso). O custo é calculado com o modelo de verdade;
 * o sufixo só marca a linha para quem for conferir com a fatura do provedor.
 */
export const ESTIMATED_MODEL_SUFFIX = ' (estimativa)';

/**
 * Apaga o currículo e o perfil de um idioma, os currículos adaptados escritos nesse idioma, as tarefas de perfil
 * do idioma (pendentes ou não) e a tradução pendente do OUTRO idioma (ela leria o perfil que está sendo apagado).
 * Notas e análises das vagas ficam: passam a contar como desatualizadas, porque a versão do perfil com que foram
 * calculadas não existe mais. Devolve false se não havia currículo, perfil nem currículo adaptado para apagar.
 * No mesmo lock das gravações de perfil: uma tarefa do worker que termine depois encontra a própria linha apagada
 * e não grava nada (ver `guard` em `saveProfile`).
 */
export async function deleteResumeData(db: Db, lang: ResumeLang): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(PROFILE_VERSION_LOCK))})`);
    await tx
      .delete(aiTasks)
      .where(and(eq(aiTasks.subject, langSubject(lang)), inArray(aiTasks.type, ['profile_extract', 'profile_translate'])));
    await tx
      .delete(aiTasks)
      .where(and(eq(aiTasks.subject, langSubject(otherLang(lang))), eq(aiTasks.type, 'profile_translate'), inArray(aiTasks.status, [...AI_PENDING])));
    const files = await tx.delete(resumes).where(eq(resumes.lang, lang)).returning({ id: resumes.id });
    const profiles = await tx.delete(candidateProfiles).where(eq(candidateProfiles.lang, lang)).returning({ id: candidateProfiles.id });
    const tailored = await tx.delete(tailoredResumes).where(eq(tailoredResumes.lang, lang)).returning({ id: tailoredResumes.id });
    return files.length + profiles.length + tailored.length > 0;
  });
}

/**
 * Apaga TUDO o que a IA de perfil guardou: currículos (arquivo e texto), perfis, currículos adaptados, notas e
 * análises das vagas e a fila de tarefas inteira. Ficam: `ai_usage` (contabilidade sem conteúdo pessoal: provedor,
 * modelo, tokens e custo; apagá-la zeraria o limite de gasto do dia), as configurações e as chaves de API (que têm
 * o próprio botão de remover na aba Configurações) e as vagas.
 */
export async function deleteAllAiData(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(PROFILE_VERSION_LOCK))})`);
    await tx.delete(aiTasks);
    await tx.delete(tailoredResumes);
    await tx.delete(jobAi);
    await tx.delete(candidateProfiles);
    await tx.delete(resumes);
    await deleteApplyData(tx);
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
