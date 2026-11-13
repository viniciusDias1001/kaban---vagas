import {
  AI_TIER2_DESCRIPTION_CHARS, CandidateProfileSchema, LIMITS, ProfileWireSchema, TailoredDraftSchema, Tier1BatchSchema, Tier2OutputSchema,
  normalizeProfile, withProfileDefaults, type AiTaskType, type CandidateProfile, type ItemKind, type JobAnalysis, type ResumeLang,
  type TailoredDraft, type Tier1Result, type Tier2Output,
} from '@kv/shared';
import { z } from 'zod';
import { AiError, parseOutput, withUsage } from './errors';
import { estimateTokens, outputAllowance } from './limits';
import { buildPrompt, condenseProfile, type TailoredCorrection } from './prompts';
import { ProfileTranslationError, mergeTranslation } from './translation';
import type { AiProvider, AiUsage } from './types';

export interface TaskResult<T> {
  data: T;
  usage: AiUsage;
  model: string;
}

/** O que as camadas precisam saber de uma vaga. */
export interface JobForAi {
  id: number;
  title: string;
  company: string;
  location: string;
  description: string;
}

/** Vagas por chamada da camada 1. */
export const TIER1_BATCH_SIZE = 10;
/** A camada 1 só envia o começo da descrição. */
export const TIER1_EXCERPT_CHARS = 1_200;
/**
 * Teto da descrição enviada na camada 2 (o que passar disso é cortado no fim). A camada 2 devolve a descrição
 * INTEIRA traduzida mais seis listas, tudo dentro de TIER2_OUTPUT_TOKENS: 12 000 caracteres de descrição viram até
 * ~14 400 de português (~4 800 tokens a 3 caracteres por token) e as listas (até 8 itens cada) ficam com o resto.
 * Com 20 000 caracteres, como era antes, a tradução sozinha já estourava o teto e a chamada era cortada (e cobrada).
 */
export const TIER2_DESCRIPTION_CHARS = AI_TIER2_DESCRIPTION_CHARS;
/** Teto da descrição enviada na camada 3, que só lê a vaga (não a traduz). */
export const TIER3_DESCRIPTION_CHARS = 20_000;
/** Tetos de saída VISÍVEL por chamada (o raciocínio é somado pelo adaptador: ver `outputAllowance`). */
export const TIER1_OUTPUT_TOKENS = (jobs: number) => 300 + 150 * jobs;
export const TIER2_OUTPUT_TOKENS = 8_000;
export const TIER3_OUTPUT_TOKENS = 6_000;

/** Teto de título, empresa e local de uma vaga dentro de qualquer prompt. */
export const JOB_FIELD_CHARS = 300;

/** Teto de saída VISÍVEL da extração e da tradução de perfil. */
export const PROFILE_OUTPUT_TOKENS = 9_000;
/** Folga em caracteres de JSON para `group` em até 60 competências, `section` e `note` por experiência e `headline`. */
export const PROFILE_LAYOUT_FIELDS_CHARS = 3_000;
/**
 * Relação entre o teto de saída e o tamanho da entrada, para a resposta não ser cortada (e cobrada) à toa:
 * - 1 token ≈ 3 caracteres de JSON em português (estimativa conservadora; o usual fica entre 3,5 e 4);
 *   então 9 000 tokens comportam um perfil de até 27 000 caracteres de JSON;
 * - o perfil extraído repete o texto do currículo com ~25% a mais de chaves, aspas e ids;
 * - os quatro campos de layout (título profissional, grupo, seção, nota) ocupam até PROFILE_LAYOUT_FIELDS_CHARS desses
 *   caracteres e não vêm do texto do currículo;
 * Logo: perfil a traduzir ≤ 27 000 caracteres de JSON; texto de currículo ≤ (27 000 - 3 000) / 1,25 = 19 200
 * caracteres (umas 6 páginas cheias). Acima disso a chamada é recusada antes de ir ao modelo.
 */
export const PROFILE_JSON_MAX_CHARS = PROFILE_OUTPUT_TOKENS * 3;
export const RESUME_TEXT_MAX_CHARS = Math.floor((PROFILE_JSON_MAX_CHARS - PROFILE_LAYOUT_FIELDS_CHARS) / 1.25);

/** Entrada grande demais para caber na resposta do modelo: recusada antes da chamada (nada é cobrado). */
export class InputTooLargeError extends AiError {
  override name = 'InputTooLargeError';
  constructor(
    readonly what: 'resume' | 'profile',
    readonly chars: number,
    readonly maxChars: number,
  ) {
    super(
      'input',
      what === 'resume'
        ? `o texto do currículo tem ${chars} caracteres; o máximo que cabe em uma extração é ${maxChars}. Envie uma versão mais curta.`
        : `o perfil tem ${chars} caracteres; o máximo que cabe em uma tradução é ${maxChars}. Reduza o perfil antes de traduzir.`,
    );
  }
}

const clip = (text: string, max: number) => text.trim().slice(0, max);

/** Espaços repetidos e linhas em branco em série (comuns em texto extraído de PDF) não gastam o limite. */
const compactText = (text: string) => text.replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Tamanho do texto de um currículo do jeito que `extractProfile` o mede: cortado em LIMITS.resumeText e com os
 * espaços compactados. Quem quer recusar um currículo longo demais ANTES de enfileirar compara isto com
 * RESUME_TEXT_MAX_CHARS, para não divergir do que a extração vai decidir.
 */
export const resumeTextChars = (text: string): number => compactText(clip(text, LIMITS.resumeText)).length;

/** Título, empresa e local cortados em JOB_FIELD_CHARS e descrição cortada no teto da camada. */
const jobFields = (job: JobForAi, descriptionChars: number) => ({
  title: clip(job.title, JOB_FIELD_CHARS),
  company: clip(job.company, JOB_FIELD_CHARS),
  location: clip(job.location, JOB_FIELD_CHARS),
  description: clip(job.description, descriptionChars),
});

/**
 * "Testar conexão": UMA chamada mínima no modelo `fast`, com prompt fixo (nada do usuário entra aqui) e
 * teto de saída minúsculo. Serve para conferir chave e modelo; custa uma fração de centavo.
 */
export async function testConnection(provider: AiProvider, opts: { signal?: AbortSignal } = {}): Promise<TaskResult<{ ok: boolean }>> {
  let res;
  try {
    res = await provider.generate({
      tier: 'fast',
      system: 'Responda somente com o JSON pedido.',
      prompt: 'Teste de conexão: devolva {"ok": true}.',
      schema: z.object({ ok: z.boolean() }),
      maxOutputTokens: 16,
      signal: opts.signal,
    });
  } catch (e) {
    // Com teto de 16 tokens um corte é esperado em alguns modelos, e prova o mesmo que uma resposta fora do
    // schema: chave e modelo funcionam. Quem chama já trata `invalid_output` assim.
    if (e instanceof AiError && e.kind === 'truncated') {
      throw new AiError('invalid_output', e.message, undefined, { usage: e.usage, model: e.model });
    }
    throw e;
  }
  return { data: res.data, usage: res.usage, model: res.model };
}

/**
 * Currículo (texto extraído) → perfil estruturado com ids. Modelo `strong`.
 * Texto acima de RESUME_TEXT_MAX_CHARS (depois de compactar espaços) lança InputTooLargeError sem chamar o modelo.
 */
export async function extractProfile(
  provider: AiProvider,
  text: string,
  opts: { signal?: AbortSignal; newId?: (kind: ItemKind) => string } = {},
): Promise<TaskResult<CandidateProfile>> {
  const compact = compactText(clip(text, LIMITS.resumeText));
  if (compact.length > RESUME_TEXT_MAX_CHARS) throw new InputTooLargeError('resume', compact.length, RESUME_TEXT_MAX_CHARS);
  const res = await provider.generate({
    tier: 'strong',
    schema: ProfileWireSchema,
    maxOutputTokens: PROFILE_OUTPUT_TOKENS,
    signal: opts.signal,
    ...buildPrompt('profile_extract', null, { text: compact }),
  });
  // Daqui em diante a chamada já foi cobrada: todo erro leva o uso.
  const billed = { usage: res.usage, model: res.model };
  try {
    const profile = parseOutput(CandidateProfileSchema, normalizeProfile(res.data, { clamp: true, newId: opts.newId }));
    if (!profile.contact.name && profile.experiences.length === 0 && profile.skills.length === 0) {
      throw new AiError('invalid_output', 'o modelo devolveu um perfil vazio');
    }
    return { data: profile, usage: res.usage, model: res.model };
  } catch (e) {
    throw withUsage(e, billed);
  }
}

/**
 * Perfil → mesmo perfil em outro idioma, com os MESMOS ids. Só os campos traduzíveis vêm do modelo;
 * nomes, empresas, instituições, datas, e-mail, telefone e URLs são copiados do original, e cada campo
 * traduzido é conferido contra o de origem (ver `mergeTranslation`). Lança:
 * - InputTooLargeError (antes da chamada) se o perfil passa de PROFILE_JSON_MAX_CHARS;
 * - ProfileTranslationError (com `violations`, `usage` e `model`) se a tradução mudou algum fato.
 */
export async function translateProfile(
  provider: AiProvider,
  stored: CandidateProfile,
  target: ResumeLang,
  opts: { signal?: AbortSignal } = {},
): Promise<TaskResult<CandidateProfile>> {
  const source = withProfileDefaults(stored);
  const size = JSON.stringify(source).length;
  if (size > PROFILE_JSON_MAX_CHARS) throw new InputTooLargeError('profile', size, PROFILE_JSON_MAX_CHARS);
  const res = await provider.generate({
    tier: 'strong',
    schema: ProfileWireSchema,
    maxOutputTokens: PROFILE_OUTPUT_TOKENS,
    signal: opts.signal,
    ...buildPrompt('profile_translate', null, { target, profile: source }),
  });
  const billed = { usage: res.usage, model: res.model };
  try {
    const { merged, violations } = mergeTranslation(source, res.data);
    if (violations.length > 0) throw new ProfileTranslationError(violations, billed);
    return { data: parseOutput(CandidateProfileSchema, normalizeProfile(merged, { clamp: true })), usage: res.usage, model: res.model };
  } catch (e) {
    throw withUsage(e, billed);
  }
}

/**
 * Camada 1: nota, idioma e título em pt-BR de até TIER1_BATCH_SIZE vagas em uma chamada. Modelo `fast`.
 * Ao modelo vão só título, empresa, local e o começo da descrição (que pode estar vazia), e o perfil
 * resumido. Devolve apenas resultados válidos de vagas que foram enviadas; uma vaga sem resultado
 * fica para a nova tentativa de quem chamou.
 */
export async function scoreJobs(
  provider: AiProvider,
  profile: CandidateProfile,
  jobs: JobForAi[],
  opts: { signal?: AbortSignal } = {},
): Promise<TaskResult<Tier1Result[]>> {
  const res = await provider.generate({
    tier: 'fast',
    schema: Tier1BatchSchema,
    maxOutputTokens: TIER1_OUTPUT_TOKENS(jobs.length),
    signal: opts.signal,
    ...buildPrompt('tier1', condenseProfile(profile), {
      jobs: jobs.map((j) => {
        const { description: excerpt, ...fields } = jobFields(j, TIER1_EXCERPT_CHARS);
        return { jobId: j.id, ...fields, excerpt };
      }),
    }),
  });
  const titles = new Map(jobs.map((j) => [j.id, j.title]));
  const seen = new Set<number>();
  const results: Tier1Result[] = [];
  for (const r of res.data.results) {
    if (!titles.has(r.jobId) || seen.has(r.jobId) || r.score < 0 || r.score > 100) continue;
    seen.add(r.jobId);
    results.push({
      jobId: r.jobId,
      language: clip(r.language, 8).toLowerCase() || 'pt',
      titlePt: clip(r.titlePt, 300) || titles.get(r.jobId)!,
      score: r.score,
      reason: clip(r.reason, 300),
    });
  }
  return { data: results, usage: res.usage, model: res.model };
}

const capList = (items: string[]) => items.map((i) => clip(i, 300)).filter(Boolean).slice(0, 12);

/** Camada 2: tradução completa da descrição e análise da vaga contra o perfil inteiro. Modelo `strong`. */
export async function analyzeJob(
  provider: AiProvider,
  profile: CandidateProfile,
  job: JobForAi,
  opts: { signal?: AbortSignal } = {},
): Promise<TaskResult<Tier2Output>> {
  const res = await provider.generate({
    tier: 'strong',
    schema: Tier2OutputSchema,
    maxOutputTokens: TIER2_OUTPUT_TOKENS,
    signal: opts.signal,
    ...buildPrompt('tier2', profile, { job: jobFields(job, TIER2_DESCRIPTION_CHARS) }),
  });
  const a = res.data.analysis;
  const analysis: JobAnalysis = {
    strengths: capList(a.strengths), gaps: capList(a.gaps), keywordsPresent: capList(a.keywordsPresent),
    keywordsMissing: capList(a.keywordsMissing), interviewTopics: capList(a.interviewTopics),
    likelyQuestions: capList(a.likelyQuestions),
  };
  return {
    data: {
      language: clip(res.data.language, 8).toLowerCase() || 'pt',
      descriptionPt: clip(res.data.descriptionPt, TIER2_DESCRIPTION_CHARS * 2),
      analysis,
    },
    usage: res.usage,
    model: res.model,
  };
}

/**
 * Camada 3: rascunho do currículo adaptado, só com referências a itens do perfil e os textos livres.
 * O resultado AINDA NÃO é confiável: quem chama passa por `resolveTailored` (verify.ts) antes de gravar.
 * `corrections` (de `toCorrections`, prompts.ts) pede uma nova tentativa depois de um rascunho bloqueado.
 */
export async function draftTailored(
  provider: AiProvider,
  profile: CandidateProfile,
  job: JobForAi,
  lang: ResumeLang,
  opts: { signal?: AbortSignal; corrections?: readonly TailoredCorrection[] } = {},
): Promise<TaskResult<TailoredDraft>> {
  const res = await provider.generate({
    tier: 'strong',
    schema: TailoredDraftSchema,
    maxOutputTokens: TIER3_OUTPUT_TOKENS,
    signal: opts.signal,
    // `corrections` só existe na nova tentativa e vai no bloco de dados (o sufixo volátil): o prefixo em cache não muda.
    ...buildPrompt('tier3', profile, {
      lang,
      job: jobFields(job, TIER3_DESCRIPTION_CHARS),
      ...(opts.corrections?.length ? { corrections: opts.corrections } : {}),
    }),
  });
  return { data: res.data, usage: res.usage, model: res.model };
}

/** Instruções de qualquer tarefa mais as marcações do prompt: bem menos que isto, em caracteres. */
const PROMPT_OVERHEAD_CHARS = 3_000;

/**
 * Uso ESTIMADO de uma tarefa que ficou em execução quando o processo morreu (o prompt não existe mais): a maior
 * entrada que a tarefa poderia ter enviado e a saída no teto da chamada. Como `estimateAbortedUsage`, serve para
 * o limite de gasto do dia errar para o lado seguro. Na camada 1 a estimativa é POR VAGA (um décimo do lote).
 */
export function estimateInterruptedUsage(type: AiTaskType): AiUsage {
  const jobFieldsChars = 3 * JOB_FIELD_CHARS;
  switch (type) {
    case 'tier1':
      return {
        inputTokens: estimateTokens(TIER1_EXCERPT_CHARS + jobFieldsChars + PROMPT_OVERHEAD_CHARS / TIER1_BATCH_SIZE),
        outputTokens: Math.ceil(outputAllowance('fast', TIER1_OUTPUT_TOKENS(TIER1_BATCH_SIZE)) / TIER1_BATCH_SIZE),
      };
    case 'tier2':
      return {
        inputTokens: estimateTokens(TIER2_DESCRIPTION_CHARS + jobFieldsChars + PROFILE_JSON_MAX_CHARS + PROMPT_OVERHEAD_CHARS),
        outputTokens: outputAllowance('strong', TIER2_OUTPUT_TOKENS),
      };
    case 'tier3':
      return {
        inputTokens: estimateTokens(TIER3_DESCRIPTION_CHARS + jobFieldsChars + PROFILE_JSON_MAX_CHARS + PROMPT_OVERHEAD_CHARS),
        outputTokens: outputAllowance('strong', TIER3_OUTPUT_TOKENS),
      };
    case 'profile_extract':
    case 'profile_translate':
      return {
        inputTokens: estimateTokens(PROFILE_JSON_MAX_CHARS + PROMPT_OVERHEAD_CHARS),
        outputTokens: outputAllowance('strong', PROFILE_OUTPUT_TOKENS),
      };
  }
}

/**
 * Idioma do currículo adaptado: vaga em português → pt-BR; qualquer outro idioma → inglês. Enquanto o
 * idioma da vaga não foi detectado (camadas 1 e 2 ainda não rodaram), vale o país da vaga.
 */
export function tailoredLangFor(jobLanguage: string | null | undefined, country?: 'BR' | 'INT'): ResumeLang {
  if (!jobLanguage) return country === 'BR' ? 'pt-BR' : 'en';
  return jobLanguage.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}
