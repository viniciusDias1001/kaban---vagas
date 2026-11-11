import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  AI_PENDING, baseProfile, enqueueAiTask, jobAi, jobSubject, jobs, latestAiTasks, toAiTaskDto, type AiTaskRow, type Db,
} from '@kv/db';
import type { AiTaskType, JobAiDetailDto, JobAiSummaryDto, LayerDto, LayerState } from '@kv/shared';
import { notConfigured, type AiContext } from '../ai-context';
import { idParam } from './ids';

const notFound = { error: 'not_found', message: 'vaga não encontrada' };
type JobAiRow = typeof jobAi.$inferSelect;

const isPending = (task: AiTaskRow) => (AI_PENDING as readonly string[]).includes(task.status);

/**
 * Estado de uma camada para a interface: a tarefa pendente manda; depois o resultado gravado (`ok` vira
 * `stale` quando foi calculado com outra versão do perfil); depois o erro.
 */
export function layerState(
  result: 'ok' | 'error' | null | undefined,
  usedVersion: number | null | undefined,
  currentVersion: number | null,
  task: AiTaskRow | undefined,
): LayerState {
  if (task && isPending(task)) return task.status as LayerState;
  if (result === 'ok') return usedVersion === currentVersion ? 'ok' : 'stale';
  if (result === 'error' || task?.status === 'error') return 'error';
  return 'none';
}

export const layerDto = (state: LayerState, task: AiTaskRow | undefined): LayerDto => ({
  state,
  task: task ? toAiTaskDto(task) : null,
});

const toSummary = (row: JobAiRow, currentVersion: number | null): JobAiSummaryDto => ({
  jobId: row.jobId, language: row.language, titlePt: row.titlePt, score: row.score, reason: row.reason,
  stale: row.tier1ProfileVersion !== currentVersion,
});

export interface AnalysisRequest {
  queued: AiTaskType[];
  /** Por que nada foi enfileirado, quando não é "já está em dia". */
  reason: 'not_configured' | 'no_profile' | 'auto_off' | null;
}

/**
 * Pede as camadas 1 e 2 de uma vaga. Idempotente: não enfileira o que já está em dia com o perfil atual
 * nem o que já tem tarefa pendente ("a mesma vaga com o mesmo perfil nunca é processada duas vezes").
 * Chamado pelo POST /jobs/:id/ai/analyze (o web o dispara ao abrir a vaga, ou pelo botão "Analisar") e,
 * com `auto: true`, quando a vaga é movida para Selecionadas. Um pedido automático respeita a
 * configuração "análise automática" (`tier2Auto`); um pedido explícito, não.
 */
export async function requestAnalysis(db: Db, ctx: AiContext, jobId: number, opts: { auto?: boolean } = {}): Promise<AnalysisRequest> {
  const state = await ctx.settings.status();
  if (!state.configured) return { queued: [], reason: 'not_configured' };
  if (opts.auto && !state.tier2Auto) return { queued: [], reason: 'auto_off' };
  const profile = await baseProfile(db);
  if (!profile) return { queued: [], reason: 'no_profile' };
  const [row] = await db.select().from(jobAi).where(eq(jobAi.jobId, jobId));
  const queued: AiTaskType[] = [];
  const fresh = (state: 'ok' | 'error' | null | undefined, version: number | null | undefined) =>
    state === 'ok' && version === profile.version;
  if (!fresh(row?.tier1State, row?.tier1ProfileVersion)) {
    if ((await enqueueAiTask(db, { type: 'tier1', jobId }, ctx.now())) !== null) queued.push('tier1');
  }
  if (!fresh(row?.tier2State, row?.tier2ProfileVersion)) {
    if ((await enqueueAiTask(db, { type: 'tier2', jobId }, ctx.now())) !== null) queued.push('tier2');
  }
  return { queued, reason: null };
}

export function jobAiRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  /** Nota, idioma e título traduzido de todas as vagas já avaliadas: o quadro junta com GET /jobs pelo id. */
  app.get('/jobs/ai', async (): Promise<JobAiSummaryDto[]> => {
    const current = (await baseProfile(db))?.version ?? null;
    const rows = await db.select().from(jobAi).where(eq(jobAi.tier1State, 'ok'));
    return rows.map((row) => toSummary(row, current));
  });

  app.get('/jobs/:id/ai', async (req, reply) => {
    const id = idParam(req);
    const [job] = id === null ? [] : await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id));
    if (!job) return reply.code(404).send(notFound);
    const [row] = await db.select().from(jobAi).where(eq(jobAi.jobId, job.id));
    const current = (await baseProfile(db))?.version ?? null;
    const tasks = await latestAiTasks(db, jobSubject(job.id), ['tier1', 'tier2']);
    const tier2 = layerState(row?.tier2State, row?.tier2ProfileVersion, current, tasks.get('tier2'));
    const detail: JobAiDetailDto = {
      summary: row?.tier1State === 'ok' ? toSummary(row, current) : null,
      tier1: layerDto(layerState(row?.tier1State, row?.tier1ProfileVersion, current, tasks.get('tier1')), tasks.get('tier1')),
      tier2: layerDto(tier2, tasks.get('tier2')),
      descriptionPt: row?.tier2State === 'ok' ? (row.descriptionPt ?? null) : null,
      analysis: row?.tier2State === 'ok' ? (row.analysis ?? null) : null,
      descriptionAvailable: row?.descriptionAvailable ?? true,
    };
    return detail;
  });

  /** Abrir a vaga pede a análise. É POST (e não efeito colateral do GET) para passar pela trava de origem. */
  app.post('/jobs/:id/ai/analyze', async (req, reply) => {
    const id = idParam(req);
    const [job] = id === null ? [] : await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id));
    if (!job) return reply.code(404).send(notFound);
    const state = await ctx.settings.status();
    if (!state.configured) return reply.code(409).send(notConfigured(state.problem));
    return reply.code(202).send(await requestAnalysis(db, ctx, job.id));
  });
}
