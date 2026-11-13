import {
  BankMatchWireSchema, ClassifyWireSchema, GateWireSchema, OpenAnswerWireSchema, ProfileFactWireSchema, QUESTION_CATEGORIES, optionKey,
  type CandidateProfile, type Question, type QuestionCategory, type ResumeLang, type Violation,
} from '@kv/shared';
import { AiError } from './errors';
import { buildPrompt, condenseProfile, toCorrections } from './prompts';
import { JOB_FIELD_CHARS, type JobForAi, type TaskResult } from './tasks';
import type { AiProvider } from './types';

/** Teto da descrição enviada à conferência da vaga (o que passar disso é cortado no fim). */
export const GATE_DESCRIPTION_CHARS = 12_000;
/** Teto da descrição enviada à resposta aberta. */
export const OPEN_DESCRIPTION_CHARS = 12_000;

const GATE_OUTPUT_TOKENS = 300;
const OPEN_OUTPUT_TOKENS_MAX = 2_000;
/** Perguntas, respostas salvas e opções por chamada: o resto é cortado, nunca enviado. */
const MAX_QUESTIONS = 60;
const MAX_CANDIDATES = 200;
const MAX_OPTIONS = 60;
const QUESTION_TEXT_CHARS = 500;
const OPTION_CHARS = 200;
const CANDIDATE_ANSWER_CHARS = 500;
const FACT_BASIS_MAX = 20;
const FACT_ANSWER_CHARS = 500;

type Opts = { signal?: AbortSignal };

const clip = (text: string, max: number) => text.trim().slice(0, max);
const isList = (q: Question) => q.kind === 'select' || q.kind === 'multiselect';

/** A pergunta como o modelo a vê: texto de terceiros, cortado. */
const questionFields = (q: Question) => ({
  questionId: q.id,
  label: clip(q.label, QUESTION_TEXT_CHARS),
  help: clip(q.help, QUESTION_TEXT_CHARS),
  kind: q.kind,
  options: q.options.slice(0, MAX_OPTIONS).map((o) => clip(o, OPTION_CHARS)),
  required: q.required,
  maxLength: q.maxLength,
});

/** O que o modelo devolveu para cada pergunta; se repete o id com conteúdo diferente, o id fica fora (na dúvida, nada). */
function byQuestion<T extends { questionId: string }>(items: T[], asked: ReadonlySet<string>): Map<string, T> {
  const out = new Map<string, T>();
  const conflicted = new Set<string>();
  for (const item of items) {
    if (!asked.has(item.questionId)) continue;
    const previous = out.get(item.questionId);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(item)) conflicted.add(item.questionId);
    else out.set(item.questionId, item);
  }
  for (const id of conflicted) out.delete(id);
  return out;
}

/**
 * Nota com a descrição inteira (cortada em GATE_DESCRIPTION_CHARS) e se algum requisito exclui o candidato. Modelo `fast`.
 * Nota fora de 0..100 é recusada (`invalid_output`, com o uso da chamada), nunca corrigida: a nota decide se a vaga entra na fila.
 */
export async function gateJob(
  provider: AiProvider,
  profile: CandidateProfile,
  job: JobForAi,
  opts: Opts = {},
): Promise<TaskResult<{ score: number; reason: string; eligible: boolean; ineligibleReason: string }>> {
  const res = await provider.generate({
    tier: 'fast',
    schema: GateWireSchema,
    maxOutputTokens: GATE_OUTPUT_TOKENS,
    signal: opts.signal,
    ...buildPrompt('apply_gate', condenseProfile(profile), {
      job: {
        title: clip(job.title, JOB_FIELD_CHARS),
        company: clip(job.company, JOB_FIELD_CHARS),
        location: clip(job.location, JOB_FIELD_CHARS),
        description: clip(job.description, GATE_DESCRIPTION_CHARS),
      },
    }),
  });
  const { score, reason, eligible, ineligibleReason } = res.data;
  if (score < 0 || score > 100) {
    throw new AiError('invalid_output', `a nota da conferência (${score}) está fora de 0 a 100`, undefined, { usage: res.usage, model: res.model });
  }
  return {
    data: { score, reason: clip(reason, 300), eligible, ineligibleReason: eligible ? '' : clip(ineligibleReason, 300) },
    usage: res.usage,
    model: res.model,
  };
}

/**
 * Categoria de cada pergunta, na ordem em que vieram. Categoria fora de QUESTION_CATEGORIES, pergunta que o modelo não
 * devolveu e pergunta com respostas conflitantes viram 'unknown'. Modelo `fast`.
 */
export async function classifyQuestions(
  provider: AiProvider,
  questions: Question[],
  opts: Opts = {},
): Promise<TaskResult<Map<string, QuestionCategory>>> {
  const asked = questions.slice(0, MAX_QUESTIONS);
  const res = await provider.generate({
    tier: 'fast',
    schema: ClassifyWireSchema,
    maxOutputTokens: 100 + 40 * asked.length,
    signal: opts.signal,
    ...buildPrompt('apply_classify', null, { questions: asked.map(questionFields) }),
  });
  const answers = byQuestion(res.data.items, new Set(asked.map((q) => q.id)));
  const known = new Set<string>(QUESTION_CATEGORIES);
  const data = new Map<string, QuestionCategory>();
  for (const q of questions) {
    const category = answers.get(q.id)?.category;
    data.set(q.id, category !== undefined && known.has(category) ? (category as QuestionCategory) : 'unknown');
  }
  return { data, usage: res.usage, model: res.model };
}

/**
 * Para cada pergunta, a resposta salva que pede a mesma informação. Id fora de `candidates`, pergunta que não foi
 * enviada e id 0 são descartados; em lista, `option` fora das opções vira null (e fora de lista é sempre null). Modelo `fast`.
 * O resultado é só uma PROPOSTA: quem chama a deixa para o dono confirmar.
 */
export async function proposeBankMatches(
  provider: AiProvider,
  questions: Question[],
  candidates: { id: number; question: string; answer: string }[],
  opts: Opts = {},
): Promise<TaskResult<Map<string, { bankAnswerId: number; option: string | null }>>> {
  const asked = questions.slice(0, MAX_QUESTIONS);
  const offered = candidates.slice(0, MAX_CANDIDATES);
  const res = await provider.generate({
    tier: 'fast',
    schema: BankMatchWireSchema,
    maxOutputTokens: 100 + 50 * asked.length,
    signal: opts.signal,
    ...buildPrompt('apply_match', null, {
      questions: asked.map(questionFields),
      candidates: offered.map((c) => ({
        id: c.id, question: clip(c.question, QUESTION_TEXT_CHARS), answer: clip(c.answer, CANDIDATE_ANSWER_CHARS),
      })),
    }),
  });
  const byId = new Map(asked.map((q) => [q.id, q]));
  const ids = new Set(offered.map((c) => c.id));
  const data = new Map<string, { bankAnswerId: number; option: string | null }>();
  for (const [questionId, item] of byQuestion(res.data.items, new Set(byId.keys()))) {
    if (!ids.has(item.bankAnswerId)) continue;
    const question = byId.get(questionId)!;
    const option = isList(question) ? (question.options.find((o) => optionKey(o) === optionKey(item.option)) ?? null) : null;
    data.set(questionId, { bankAnswerId: item.bankAnswerId, option });
  }
  return { data, usage: res.usage, model: res.model };
}

/**
 * Respostas factuais com os ids do perfil em que se apoiam. Item `unknown`, sem resposta, de pergunta que não foi
 * enviada ou conflitante fica fora do mapa. O resultado AINDA NÃO é confiável: quem chama passa por `verifyProfileFact`.
 * Modelo `fast`.
 */
export async function answerProfileFacts(
  provider: AiProvider,
  profile: CandidateProfile,
  questions: Question[],
  opts: Opts = {},
): Promise<TaskResult<Map<string, { answer: string; basis: string[] }>>> {
  const asked = questions.slice(0, MAX_QUESTIONS);
  const res = await provider.generate({
    tier: 'fast',
    schema: ProfileFactWireSchema,
    maxOutputTokens: 100 + 100 * asked.length,
    signal: opts.signal,
    ...buildPrompt('apply_facts', profile, { questions: asked.map(questionFields) }),
  });
  const data = new Map<string, { answer: string; basis: string[] }>();
  for (const [questionId, item] of byQuestion(res.data.items, new Set(asked.map((q) => q.id)))) {
    const answer = clip(item.answer, FACT_ANSWER_CHARS);
    if (item.unknown || answer === '') continue;
    data.set(questionId, { answer, basis: [...new Set(item.basis.map((b) => clip(b, 100)))].slice(0, FACT_BASIS_MAX) });
  }
  return { data, usage: res.usage, model: res.model };
}

/**
 * Texto de uma resposta aberta, no idioma `lang`. O resultado AINDA NÃO é confiável: quem chama passa por
 * `verifyOpenAnswer` (apply-verify.ts), que confere números, nomes e `question.maxLength`. `violations` é a lista da
 * tentativa anterior (volta ao modelo só como código, trecho e termo). Modelo `strong`.
 */
export async function writeOpenAnswer(
  provider: AiProvider,
  input: { profile: CandidateProfile; job: JobForAi; question: Question; lang: ResumeLang; violations?: Violation[] },
  opts: Opts = {},
): Promise<TaskResult<string>> {
  const { profile, job, question, lang, violations } = input;
  const corrections = violations?.length ? toCorrections(violations) : [];
  const res = await provider.generate({
    tier: 'strong',
    schema: OpenAnswerWireSchema,
    maxOutputTokens: Math.min(OPEN_OUTPUT_TOKENS_MAX, 300 + Math.ceil((question.maxLength ?? 2_000) / 2)),
    signal: opts.signal,
    ...buildPrompt('apply_open', profile, {
      lang,
      job: {
        title: clip(job.title, JOB_FIELD_CHARS),
        company: clip(job.company, JOB_FIELD_CHARS),
        description: clip(job.description, OPEN_DESCRIPTION_CHARS),
      },
      question: questionFields(question),
      ...(corrections.length ? { corrections } : {}),
    }),
  });
  return { data: res.data.text.trim(), usage: res.usage, model: res.model };
}
