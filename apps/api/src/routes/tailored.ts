import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describeViolations, isStructural, resolveTailored, tailoredLangFor, type ResolveOptions } from '@kv/ai';
import {
  AI_PENDING, enqueueAiTask, jobAi, jobSubject, jobs, latestAiTasks, profileFor, tailoredResumes, toAiTaskDto, type Db,
} from '@kv/db';
import { ResumePdfError, unsupportedPdfCharacters } from '@kv/resume';
import {
  TailoredEditSchema, draftOf, type LayerState, type PdfWarningsDto, type TailoredDto, type TailoredResume, type TailoredSaveDto,
  type TailoredStateDto, type Violation,
} from '@kv/shared';
import { notConfigured, type AiContext } from '../ai-context';
import { idParam } from './ids';

const notFound = { error: 'not_found', message: 'vaga não encontrada' };
const noTailored = { error: 'not_found', message: 'esta vaga ainda não tem currículo adaptado' };
const LANG_NAMES = { 'pt-BR': 'português', en: 'inglês' } as const;
type TailoredRow = typeof tailoredResumes.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

/**
 * O que impede SALVAR uma edição do usuário: estrutura (id inexistente ou repetido) e limites de tamanho. O
 * resto (número novo, empresa da vaga, termo novo, texto sem relação) vira aviso: o texto agora é do usuário.
 */
export const blocksEdit = (v: Violation): boolean => isStructural(v) || v.code === 'limit';

/** Sequência de renderizações de PDF: o desenho é síncrono e usa a CPU do processo; uma de cada vez. */
let renderTail: Promise<unknown> = Promise.resolve();
function renderOneAtATime(render: AiContext['renderPdf'], resume: TailoredResume): Promise<Buffer> {
  const result = renderTail.then(() => render(resume));
  // A fila anda mesmo quando esta renderização falha: o erro vai só para quem a pediu.
  renderTail = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Caracteres sem glifo (ou texto longo demais) do currículo, sem lançar. */
export function pdfWarningsOf(resume: TailoredResume): PdfWarningsDto {
  try {
    return { unsupportedCharacters: unsupportedPdfCharacters(resume), tooLong: false };
  } catch (e) {
    if (e instanceof ResumePdfError && e.code === 'too_long') return { unsupportedCharacters: [], tooLong: true };
    throw e;
  }
}

export function tailoredRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  async function findJob(req: { params: unknown }) {
    const id = idParam(req);
    const [job] = id === null ? [] : await db.select().from(jobs).where(eq(jobs.id, id));
    return job ?? null;
  }
  const findTailored = async (jobId: number): Promise<TailoredRow | null> =>
    (await db.select().from(tailoredResumes).where(eq(tailoredResumes.jobId, jobId)))[0] ?? null;

  /**
   * O que o verificador sabe da vaga: empresa, título e as palavras-chave da análise da camada 2 (quando existe).
   * É o mesmo contexto que o worker usa ao gerar, para a edição e o PDF não aceitarem o que a geração barraria.
   */
  async function verifierContext(job: JobRow): Promise<ResolveOptions> {
    const [ai] = await db
      .select({ tier2State: jobAi.tier2State, analysis: jobAi.analysis })
      .from(jobAi)
      .where(eq(jobAi.jobId, job.id));
    const keywords = ai?.tier2State === 'ok' && ai.analysis ? [...ai.analysis.keywordsMissing, ...ai.analysis.keywordsPresent] : [];
    return { jobCompany: job.company, jobTitle: job.title, jobKeywords: keywords };
  }

  async function toDto(row: TailoredRow): Promise<TailoredDto> {
    // Versão do perfil do IDIOMA deste currículo (a que a geração ou a edição usou), não a do perfil-base.
    const profile = await profileFor(db, row.lang);
    return {
      jobId: row.jobId, lang: row.lang, content: row.content, profileVersion: row.profileVersion,
      stale: profile?.version !== row.profileVersion, createdAt: row.createdAt, editedAt: row.editedAt,
      pdfWarnings: pdfWarningsOf(row.content),
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
   * do perfil. Id inexistente ou repetido e texto fora dos limites são recusados (400). Número novo, nome
   * da empresa da vaga, termo que não está no perfil (inclusive do título e das palavras-chave da vaga) e
   * texto sem relação com a realização original viram avisos: o texto agora é do usuário.
   */
  app.put('/jobs/:id/tailored', async (req, reply) => {
    const job = await findJob(req);
    const edit = TailoredEditSchema.parse(req.body);
    if (!job) return reply.code(404).send(notFound);
    const row = await findTailored(job.id);
    if (!row) return reply.code(404).send(noTailored);
    const profile = await profileFor(db, row.lang);
    if (!profile) return reply.code(409).send({ error: 'profile_missing', message: 'o perfil deste idioma não existe mais' });
    const { resume, violations } = resolveTailored(edit, profile.data, row.lang, await verifierContext(job));
    const blocking = violations.filter(blocksEdit);
    if (blocking.length > 0) {
      return reply.code(400).send({ error: 'validation', message: describeViolations(blocking) });
    }
    const [saved] = await db
      .update(tailoredResumes)
      .set({ content: resume, profileVersion: profile.version, editedAt: ctx.now() })
      .where(eq(tailoredResumes.id, row.id))
      .returning();
    // Tudo o que sobrou em `violations` é aviso (o que bloqueia já respondeu 400 acima).
    const body: TailoredSaveDto = { tailored: await toDto(saved), warnings: violations };
    return body;
  });

  /**
   * PDF gerado no servidor a partir do conteúdo revisado. Mesma origem: a CSP das páginas não muda.
   *
   * Antes de desenhar, o conteúdo é conferido de novo contra o perfil de agora: o perfil pode ter mudado depois
   * de o currículo ser salvo. Saída de modelo que não passa mais é recusada por qualquer violação; um currículo
   * que o usuário já revisou, só por violação que bloqueia a edição (estrutura e limites). Recusa = 409 com as
   * violações. Falta de glifo e texto longo demais viram 422 com mensagem para o usuário.
   */
  app.get('/jobs/:id/tailored.pdf', async (req, reply) => {
    const job = await findJob(req);
    if (!job) return reply.code(404).send(notFound);
    const row = await findTailored(job.id);
    if (!row) return reply.code(404).send(noTailored);
    const profile = await profileFor(db, row.lang);
    if (!profile) return reply.code(409).send({ error: 'profile_missing', message: 'o perfil deste idioma não existe mais' });
    const { violations } = resolveTailored(draftOf(row.content), profile.data, row.lang, await verifierContext(job));
    const blocking = row.editedAt === null ? violations : violations.filter(blocksEdit);
    if (blocking.length > 0) {
      return reply.code(409).send({
        error: 'verification_failed',
        message: `O currículo não confere mais com o seu perfil e não pode virar PDF: ${describeViolations(blocking).slice(0, 600)}. Revise o texto e salve, ou adapte o currículo de novo.`,
        violations: blocking,
      });
    }
    let pdf: Buffer;
    try {
      pdf = await renderOneAtATime(ctx.renderPdf, row.content);
    } catch (e) {
      if (!(e instanceof ResumePdfError)) throw e;
      const body = { error: 'pdf_unavailable', message: e.message, code: e.code };
      return reply.code(422).send(e.characters.length > 0 ? { ...body, characters: e.characters } : body);
    }
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="curriculo-vaga-${job.id}.pdf"`)
      .header('cache-control', 'no-store')
      .send(pdf);
  });
}
