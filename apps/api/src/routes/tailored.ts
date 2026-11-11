import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describeViolations, isStructural, resolveTailored, tailoredLangFor } from '@kv/ai';
import {
  AI_PENDING, enqueueAiTask, jobAi, jobSubject, jobs, latestAiTasks, profileFor, tailoredResumes, toAiTaskDto, type Db,
} from '@kv/db';
import { renderResumePdf } from '@kv/resume';
import { TailoredEditSchema, type LayerState, type TailoredDto, type TailoredSaveDto, type TailoredStateDto } from '@kv/shared';
import { notConfigured, type AiContext } from '../ai-context';
import { idParam } from './ids';

const notFound = { error: 'not_found', message: 'vaga não encontrada' };
const noTailored = { error: 'not_found', message: 'esta vaga ainda não tem currículo adaptado' };
const LANG_NAMES = { 'pt-BR': 'português', en: 'inglês' } as const;
type TailoredRow = typeof tailoredResumes.$inferSelect;

export function tailoredRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  async function findJob(req: { params: unknown }) {
    const id = idParam(req);
    const [job] = id === null ? [] : await db.select().from(jobs).where(eq(jobs.id, id));
    return job ?? null;
  }
  const findTailored = async (jobId: number): Promise<TailoredRow | null> =>
    (await db.select().from(tailoredResumes).where(eq(tailoredResumes.jobId, jobId)))[0] ?? null;

  async function toDto(row: TailoredRow): Promise<TailoredDto> {
    const profile = await profileFor(db, row.lang);
    return {
      jobId: row.jobId, lang: row.lang, content: row.content, profileVersion: row.profileVersion,
      stale: profile?.version !== row.profileVersion, createdAt: row.createdAt, editedAt: row.editedAt,
    };
  }

  app.get('/jobs/:id/tailored', async (req, reply) => {
    const job = await findJob(req);
    if (!job) return reply.code(404).send(notFound);
    const row = await findTailored(job.id);
    const task = (await latestAiTasks(db, jobSubject(job.id), ['tier3'])).get('tier3');
    const tailored = row ? await toDto(row) : null;
    let state: LayerState = 'none';
    if (task && (AI_PENDING as readonly string[]).includes(task.status)) state = task.status as LayerState;
    else if (task?.status === 'error') state = 'error'; // a última tentativa falhou (ex.: verificador bloqueou)
    else if (tailored) state = tailored.stale ? 'stale' : 'ok';
    const body: TailoredStateDto = { state, task: task ? toAiTaskDto(task) : null, tailored };
    return body;
  });

  /** Botão "Adaptar currículo": enfileira a camada 3. Nada é gerado dentro da requisição. */
  app.post('/jobs/:id/tailored', async (req, reply) => {
    const job = await findJob(req);
    if (!job) return reply.code(404).send(notFound);
    const state = await ctx.settings.status();
    if (!state.configured) return reply.code(409).send(notConfigured(state.problem));
    const [ai] = await db.select({ language: jobAi.language }).from(jobAi).where(eq(jobAi.jobId, job.id));
    const lang = tailoredLangFor(ai?.language, job.country);
    const profile = await profileFor(db, lang);
    if (!profile) {
      return reply.code(409).send({
        error: 'profile_missing',
        message: `Esta vaga pede um currículo em ${LANG_NAMES[lang]} e não há perfil nesse idioma. Envie o currículo ou gere o perfil por tradução em Meu perfil.`,
      });
    }
    const existing = await findTailored(job.id);
    // Mesmo perfil, mesma vaga: reaproveita o que já existe.
    if (existing && existing.lang === lang && existing.profileVersion === profile.version) {
      return reply.code(200).send({ queued: false });
    }
    const id = await enqueueAiTask(db, { type: 'tier3', jobId: job.id }, ctx.now());
    return reply.code(202).send({ queued: id !== null });
  });

  /**
   * Edição do usuário. O corpo é um rascunho (referências + textos); o servidor refaz a cópia dos campos
   * do perfil. Id inexistente ou repetido é recusado (400). Número novo e nome da empresa da vaga viram
   * avisos: o texto agora é do usuário.
   */
  app.put('/jobs/:id/tailored', async (req, reply) => {
    const job = await findJob(req);
    const edit = TailoredEditSchema.parse(req.body);
    if (!job) return reply.code(404).send(notFound);
    const row = await findTailored(job.id);
    if (!row) return reply.code(404).send(noTailored);
    const profile = await profileFor(db, row.lang);
    if (!profile) return reply.code(409).send({ error: 'profile_missing', message: 'o perfil deste idioma não existe mais' });
    const { resume, violations } = resolveTailored(edit, profile.data, row.lang, { jobCompany: job.company });
    const structural = violations.filter(isStructural);
    if (structural.length > 0) {
      return reply.code(400).send({ error: 'validation', message: describeViolations(structural) });
    }
    const [saved] = await db
      .update(tailoredResumes)
      .set({ content: resume, profileVersion: profile.version, editedAt: ctx.now() })
      .where(eq(tailoredResumes.id, row.id))
      .returning();
    const body: TailoredSaveDto = { tailored: await toDto(saved), warnings: violations };
    return body;
  });

  /** PDF gerado no servidor a partir do conteúdo revisado. Mesma origem: a CSP das páginas não muda. */
  app.get('/jobs/:id/tailored.pdf', async (req, reply) => {
    const job = await findJob(req);
    if (!job) return reply.code(404).send(notFound);
    const row = await findTailored(job.id);
    if (!row) return reply.code(404).send(noTailored);
    const pdf = await renderResumePdf(row.content);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="curriculo-vaga-${job.id}.pdf"`)
      .header('cache-control', 'no-store')
      .send(pdf);
  });
}
