import {
  EMAIL_KINDS, EmailClassifyWireSchema, EmailDraftWireSchema, KNOWN_FACTS, MAIL_LIMITS,
  type CandidateProfile, type EmailKind, type EmailLang, type EmailRequest, type KnownFact,
} from '@kv/shared';
import { stripContacts } from './email-verify';
import { buildPrompt } from './prompts';
import type { TaskResult } from './tasks';
import type { AiProvider } from './types';

/**
 * As duas tarefas de IA do e-mail. O e-mail é texto de terceiros: vai ao modelo só dentro de <dados>, cortado, e nada
 * do que o modelo devolve vira endereço, destinatário ou texto enviado sem o dono aprovar.
 */

/** Um e-mail recebido, como o modelo o vê. `date` em milissegundos. */
export interface EmailForAi { fromName: string; fromAddress: string; subject: string; date: number; text: string }
/** Uma vaga que o código achou que pode ser a do e-mail. `appliedAt` em milissegundos. */
export interface EmailCandidateForAi { id: number; company: string; title: string; appliedAt: number }
export interface EmailClassification { kind: EmailKind; jobId: number | null; requests: EmailRequest[]; lang: EmailLang; summary: string }

export interface EmailDraftInput {
  profile: CandidateProfile; mail: EmailForAi; kind: 'entrevista' | 'pedido'; lang: EmailLang;
  /** O que foi pedido, com o valor salvo quando há (texto já pronto para citar). */
  requests: { fact: KnownFact | 'outro'; note: string; saved: string | null }[];
  company: string | null; jobTitle: string | null;
  /** As violações de `verifyEmailDraft` na tentativa anterior. */
  violations?: string[];
}

type Opts = { signal?: AbortSignal };

const CLASSIFY_OUTPUT_TOKENS = 800;
/** `draftChars` caracteres a ~3 caracteres por token, com folga para o JSON. */
const DRAFT_OUTPUT_TOKENS = 1_600;
/** Descrição de cada pedido, na volta do modelo e na ida ao rascunho. */
const NOTE_CHARS = 200;
const MAX_REQUESTS = 15;
const NAME_CHARS = 200;
const ADDRESS_CHARS = 254;
const SAVED_CHARS = 1_000;
const MAX_CORRECTIONS = 10;
const CORRECTION_CHARS = 200;

const clip = (text: string, max: number) => text.trim().slice(0, max);
/** Uma linha: quebras e espaços seguidos viram um espaço. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const isoDate = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');

/** O e-mail como vai dentro de <dados>: tudo cortado. */
const mailFields = (mail: EmailForAi) => ({
  fromName: clip(mail.fromName, NAME_CHARS),
  fromAddress: clip(mail.fromAddress, ADDRESS_CHARS),
  subject: clip(mail.subject, MAIL_LIMITS.subjectChars),
  date: isoDate(mail.date),
  text: clip(mail.text, MAIL_LIMITS.bodyChars),
});

const KINDS = new Set<string>(EMAIL_KINDS);
const FACTS = new Set<string>(KNOWN_FACTS);

/**
 * Tipo, card, pedidos, idioma e resumo de um e-mail de vaga. Modelo `fast`. O e-mail e as candidatas (no máximo
 * MAIL_LIMITS.candidates) vão em `<dados>`. Depois de validar: tipo fora da lista vira `outro`; fato fora da lista vira
 * `outro`; `jobId` fora das candidatas (ou 0) vira null; idioma fora da lista vira `pt-BR`; resumo numa linha, cortado
 * em MAIL_LIMITS.summaryChars; `requests` só é mantido quando o tipo é `pedido`, com a descrição cortada e um item por
 * fato conhecido. Endereços e links que o modelo escreva no resumo ou na descrição de um pedido são tirados.
 */
export async function classifyEmail(
  provider: AiProvider,
  input: { mail: EmailForAi; candidates: EmailCandidateForAi[] },
  opts: Opts = {},
): Promise<TaskResult<EmailClassification>> {
  const offered = input.candidates.slice(0, MAIL_LIMITS.candidates);
  const res = await provider.generate({
    tier: 'fast',
    schema: EmailClassifyWireSchema,
    maxOutputTokens: CLASSIFY_OUTPUT_TOKENS,
    signal: opts.signal,
    ...buildPrompt('email_classify', null, {
      mail: mailFields(input.mail),
      candidates: offered.map((c) => ({
        id: c.id, company: clip(c.company, NAME_CHARS), title: clip(c.title, NAME_CHARS), appliedAt: isoDate(c.appliedAt).slice(0, 10),
      })),
    }),
  });
  const out = res.data;
  const kind: EmailKind = KINDS.has(out.kind) ? (out.kind as EmailKind) : 'outro';
  const jobId = out.jobId !== 0 && offered.some((c) => c.id === out.jobId) ? out.jobId : null;
  const lang: EmailLang = out.lang === 'en' ? 'en' : 'pt-BR';
  const requests: EmailRequest[] = [];
  if (kind === 'pedido') {
    const seen = new Set<string>();
    for (const item of out.requests.slice(0, MAX_REQUESTS)) {
      const fact = FACTS.has(item.fact) ? (item.fact as KnownFact) : 'outro';
      if (fact !== 'outro' && seen.has(fact)) continue;
      seen.add(fact);
      requests.push({ fact, note: clip(oneLine(stripContacts(item.note)), NOTE_CHARS) });
    }
  }
  return {
    data: { kind, jobId, requests, lang, summary: clip(oneLine(stripContacts(out.summary)), MAIL_LIMITS.summaryChars) },
    usage: res.usage,
    model: res.model,
  };
}

/**
 * Corpo do rascunho de resposta, cortado em MAIL_LIMITS.draftChars. Modelo `strong`. O resultado AINDA NÃO é
 * confiável: quem chama passa por `verifyEmailDraft` e, de todo jeito, o rascunho só sai com a aprovação do dono.
 * `violations` volta ao modelo dentro de `<dados>`, como "corrections".
 */
export async function draftEmailReply(provider: AiProvider, input: EmailDraftInput, opts: Opts = {}): Promise<TaskResult<string>> {
  const corrections = (input.violations ?? []).slice(0, MAX_CORRECTIONS).map((v) => clip(oneLine(v), CORRECTION_CHARS));
  const res = await provider.generate({
    tier: 'strong',
    schema: EmailDraftWireSchema,
    maxOutputTokens: DRAFT_OUTPUT_TOKENS,
    signal: opts.signal,
    ...buildPrompt('email_draft', input.profile, {
      kind: input.kind,
      lang: input.lang,
      company: input.company === null ? null : clip(input.company, NAME_CHARS),
      jobTitle: input.jobTitle === null ? null : clip(input.jobTitle, NAME_CHARS),
      mail: mailFields(input.mail),
      requests: input.requests.slice(0, MAX_REQUESTS).map((r) => ({
        fact: r.fact, note: clip(r.note, NOTE_CHARS), saved: r.saved === null ? null : clip(r.saved, SAVED_CHARS),
      })),
      ...(corrections.length ? { corrections } : {}),
    }),
  });
  return { data: res.data.text.trim().slice(0, MAIL_LIMITS.draftChars), usage: res.usage, model: res.model };
}
