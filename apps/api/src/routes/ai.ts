import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RESUME_TEXT_MAX_CHARS, dayStartMs, resumeTextChars } from '@kv/ai';
import {
  aiSpentSince, candidateProfiles, confirmAiTask, enqueueAiTask, langSubject, latestAiTasks, profileFor, resumes,
  saveProfile, toAiTaskDto, usageByLayer, type CandidateProfileRow, type Db,
} from '@kv/db';
import { EXTRACT_LIMITS, RESUME_MIME, sniffResume, type ExtractFailure, type ResumeKind } from '@kv/resume';
import {
  CandidateProfileSchema, LIMITS, ProfileWireSchema, RESUME_LANGS, ResumeLangSchema, normalizeProfile, otherLang,
  type AiStatusDto, type AiTaskDto, type AiUsageDto, type CandidateProfileDto, type ProfileOverviewDto,
  type ResumeMetaDto,
} from '@kv/shared';
import { notConfigured, type AiContext } from '../ai-context';
import { idParam } from './ids';

const THIRTY_DAYS = 30 * 86_400_000;
const LANG_NAMES = { 'pt-BR': 'português', en: 'inglês' } as const;

/** Uma página de currículo cheia de texto tem uns 3 000 caracteres: só para dizer o limite em palavras. */
const CHARS_PER_PAGE = 3_000;

/**
 * Mensagem por tipo de falha da extração. Frases fixas: o texto que o leitor de PDF/DOCX devolve pode trazer
 * caminhos, nomes de módulos e trechos do arquivo, e não sai do servidor.
 */
const EXTRACT_MESSAGES: Record<ExtractFailure, (kind: ResumeKind) => string> = {
  invalid: (kind) => (kind === 'pdf' ? 'O arquivo não é um PDF válido ou está protegido por senha.' : 'O arquivo não é um DOCX válido.'),
  no_text: (kind) =>
    kind === 'pdf'
      ? 'Este PDF não tem texto extraível (parece ser uma imagem escaneada). Exporte o currículo como PDF com texto ou envie um DOCX.'
      : 'Este DOCX não tem texto.',
  too_many_pages: () => `O PDF tem páginas demais (o limite é ${EXTRACT_LIMITS.maxPages}). Envie uma versão mais curta do currículo.`,
  too_large: () => 'O arquivo é grande demais depois de lido (ou ocupa memória demais) e foi recusado.',
  timeout: () => 'O arquivo demorou demais para ser lido e foi recusado.',
};

const langParam = (req: { params: unknown }) => ResumeLangSchema.parse((req.params as { lang?: string }).lang);

export const toProfileDto = (row: CandidateProfileRow): CandidateProfileDto => ({
  lang: row.lang, data: row.data, origin: row.origin, version: row.version, updatedAt: row.updatedAt,
});

/** Nome do arquivo só para exibição: sem caminho, sem caracteres de controle, com tamanho limitado. */
function safeFileName(raw: string | undefined, fallback: string): string {
  const name = (raw ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, LIMITS.resumeFileName) || fallback;
}

export function aiRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  app.get('/ai/status', async (): Promise<AiStatusDto> => {
    // Provedor, modelos e orçamento em vigor (tela > ambiente > padrão). Nada aqui contém a chave.
    const state = await ctx.settings.status();
    const { budgetTimeZone: timeZone, dailyBudgetUsd: dailyUsd } = state;
    // O mesmo início de dia que o worker usa para pausar e retomar (dayStartMs).
    const spentTodayUsd = await aiSpentSince(db, dayStartMs(ctx.now(), timeZone));
    return {
      configured: state.configured,
      problem: state.problem,
      provider: state.provider,
      models: state.models,
      tier2Auto: state.tier2Auto,
      budget: { dailyUsd, spentTodayUsd, exceeded: spentTodayUsd >= dailyUsd, timeZone },
    };
  });

  app.get('/ai/usage', async (): Promise<AiUsageDto> => {
    const now = ctx.now();
    const timeZone = (await ctx.settings.status()).budgetTimeZone;
    return {
      today: await usageByLayer(db, dayStartMs(now, timeZone)),
      last30Days: await usageByLayer(db, now - THIRTY_DAYS),
    };
  });

  app.get('/ai/profile', async (): Promise<ProfileOverviewDto> => {
    // Nunca seleciona `content`: são até 5 MiB por currículo.
    const files = await db
      .select({
        lang: resumes.lang, fileName: resumes.fileName, mime: resumes.mime, uploadedAt: resumes.uploadedAt,
        size: sql<number>`octet_length(${resumes.content})`.mapWith(Number),
      })
      .from(resumes)
      .orderBy(desc(resumes.lang));
    const profiles = await db.select().from(candidateProfiles).orderBy(desc(candidateProfiles.lang));
    const tasks: AiTaskDto[] = [];
    for (const lang of RESUME_LANGS) {
      const latest = [...(await latestAiTasks(db, langSubject(lang), ['profile_extract', 'profile_translate'])).values()];
      latest.sort((a, b) => b.id - a.id);
      if (latest[0]) tasks.push(toAiTaskDto(latest[0]));
    }
    return { resumes: files satisfies ResumeMetaDto[], profiles: profiles.map(toProfileDto), tasks };
  });

  app.post('/ai/resumes/:lang', async (req, reply) => {
    const lang = langParam(req);
    const state = await ctx.settings.status();
    if (!state.configured) return reply.code(409).send(notConfigured(state.problem));
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: 'bad_request', message: 'envie o arquivo como multipart/form-data, no campo "file"' });
    }
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'bad_request', message: 'nenhum arquivo enviado' });
    // Acima de LIMITS.resumeBytes o plugin lança 413, que o error handler devolve como bad_request.
    const content = await file.toBuffer();
    const kind = sniffResume(content);
    if (!kind) {
      return reply.code(400).send({ error: 'unsupported_type', message: 'Envie um PDF ou um DOCX. O tipo é conferido pelo conteúdo do arquivo.' });
    }
    const extracted = await ctx.extractResume(content, kind);
    if (!extracted.ok) {
      const message = (EXTRACT_MESSAGES[extracted.reason] ?? EXTRACT_MESSAGES.invalid)(kind);
      return reply.code(422).send({ error: 'unreadable_resume', message });
    }
    // O mesmo critério da extração de perfil: um currículo que ela recusaria não vira tarefa na fila.
    if (resumeTextChars(extracted.text) > RESUME_TEXT_MAX_CHARS) {
      return reply.code(422).send({
        error: 'resume_too_long',
        message:
          `O texto do currículo é longo demais para a IA ler de uma vez: o limite é de cerca de ${Math.floor(RESUME_TEXT_MAX_CHARS / CHARS_PER_PAGE)} páginas de texto. ` +
          'Envie uma versão mais curta.',
      });
    }

    const values = {
      fileName: safeFileName(file.filename, `curriculo.${kind}`),
      mime: RESUME_MIME[kind],
      content,
      extractedText: extracted.text,
      uploadedAt: ctx.now(),
    };
    await db.insert(resumes).values({ lang, ...values }).onConflictDoUpdate({ target: resumes.lang, set: values });
    await enqueueAiTask(db, { type: 'profile_extract', lang }, ctx.now());
    const meta: ResumeMetaDto = { lang, fileName: values.fileName, mime: values.mime, size: content.length, uploadedAt: values.uploadedAt };
    return reply.code(201).send(meta);
  });

  /** O arquivo original, como foi enviado. */
  app.get('/ai/resumes/:lang/file', async (req, reply) => {
    const lang = langParam(req);
    const [row] = await db.select().from(resumes).where(eq(resumes.lang, lang));
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'currículo não encontrado' });
    // Só os dois tipos que o upload grava; qualquer outro valor no banco sai como binário genérico. Nunca inline.
    const kind = row.mime === RESUME_MIME.pdf ? 'pdf' : row.mime === RESUME_MIME.docx ? 'docx' : null;
    return reply
      .header('content-type', kind ? RESUME_MIME[kind] : 'application/octet-stream')
      .header('content-disposition', `attachment; filename="curriculo-${lang}.${kind ?? 'bin'}"`)
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'no-store')
      .send(row.content);
  });

  /** Edição do perfil pelo usuário: mantém os ids existentes, cria ids para itens novos, sobe a versão. */
  app.put('/ai/profile/:lang', async (req, reply) => {
    const lang = langParam(req);
    const { data } = z.object({ data: ProfileWireSchema }).parse(req.body);
    const profile = CandidateProfileSchema.parse(normalizeProfile(data, { clamp: false }));
    if (!(await profileFor(db, lang))) return reply.code(404).send({ error: 'not_found', message: 'perfil não encontrado' });
    return toProfileDto(await saveProfile(db, lang, profile, 'editado', ctx.now()));
  });

  /** Gera o perfil de `:lang` por tradução do outro idioma. */
  app.post('/ai/profile/:lang/translate', async (req, reply) => {
    const lang = langParam(req);
    const state = await ctx.settings.status();
    if (!state.configured) return reply.code(409).send(notConfigured(state.problem));
    if (!(await profileFor(db, otherLang(lang)))) {
      return reply.code(409).send({ error: 'profile_missing', message: `Não há perfil em ${LANG_NAMES[otherLang(lang)]} para traduzir.` });
    }
    const target = await profileFor(db, lang);
    if (target && target.origin !== 'traduzido') {
      return reply.code(409).send({ error: 'conflict', message: `Já existe um perfil em ${LANG_NAMES[lang]} que não veio de tradução.` });
    }
    const id = await enqueueAiTask(db, { type: 'profile_translate', lang }, ctx.now());
    return reply.code(202).send({ queued: id !== null });
  });

  /** O usuário aceita gastar acima do limite do dia nesta tarefa. */
  app.post('/ai/tasks/:id/confirm', async (req, reply) => {
    const id = idParam(req);
    if (id === null || !(await confirmAiTask(db, id))) {
      return reply.code(404).send({ error: 'not_found', message: 'tarefa não encontrada ou não está aguardando confirmação' });
    }
    return reply.code(202).send({ queued: true });
  });
}
