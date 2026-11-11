import {
  CandidateProfileSchema, LIMITS, ProfileWireSchema, TailoredDraftSchema, Tier1BatchSchema, Tier2OutputSchema,
  normalizeProfile, type CandidateProfile, type ItemKind, type JobAnalysis, type ProfileWire, type ResumeLang,
  type TailoredDraft, type Tier1Result, type Tier2Output,
} from '@kv/shared';
import { z } from 'zod';
import { AiError, parseOutput } from './errors';
import { buildPrompt, condenseProfile } from './prompts';
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
/** Teto da descrição enviada nas camadas 2 e 3 (o que passar disso é cortado no fim). */
export const TIER2_DESCRIPTION_CHARS = 20_000;

const clip = (text: string, max: number) => text.trim().slice(0, max);

/**
 * "Testar conexão": UMA chamada mínima no modelo `fast`, com prompt fixo (nada do usuário entra aqui) e
 * teto de saída minúsculo. Serve para conferir chave e modelo; custa uma fração de centavo.
 */
export async function testConnection(provider: AiProvider, opts: { signal?: AbortSignal } = {}): Promise<TaskResult<{ ok: boolean }>> {
  const res = await provider.generate({
    tier: 'fast',
    system: 'Responda somente com o JSON pedido.',
    prompt: 'Teste de conexão: devolva {"ok": true}.',
    schema: z.object({ ok: z.boolean() }),
    maxOutputTokens: 16,
    signal: opts.signal,
  });
  return { data: res.data, usage: res.usage, model: res.model };
}

/** Currículo (texto extraído) → perfil estruturado com ids. Modelo `strong`. */
export async function extractProfile(
  provider: AiProvider,
  text: string,
  opts: { signal?: AbortSignal; newId?: (kind: ItemKind) => string } = {},
): Promise<TaskResult<CandidateProfile>> {
  const res = await provider.generate({
    tier: 'strong',
    schema: ProfileWireSchema,
    maxOutputTokens: 8_000,
    signal: opts.signal,
    ...buildPrompt('profile_extract', null, { text: clip(text, LIMITS.resumeText) }),
  });
  const profile = parseOutput(CandidateProfileSchema, normalizeProfile(res.data, { clamp: true, newId: opts.newId }));
  if (!profile.contact.name && profile.experiences.length === 0 && profile.skills.length === 0) {
    throw new AiError('invalid_output', 'o modelo devolveu um perfil vazio');
  }
  return { data: profile, usage: res.usage, model: res.model };
}

/**
 * Perfil → mesmo perfil em outro idioma, com os MESMOS ids. Só os campos traduzíveis vêm do modelo;
 * nomes, empresas, instituições, datas, e-mail, telefone e URLs são copiados do original.
 */
export async function translateProfile(
  provider: AiProvider,
  source: CandidateProfile,
  target: ResumeLang,
  opts: { signal?: AbortSignal } = {},
): Promise<TaskResult<CandidateProfile>> {
  const res = await provider.generate({
    tier: 'strong',
    schema: ProfileWireSchema,
    maxOutputTokens: 8_000,
    signal: opts.signal,
    ...buildPrompt('profile_translate', null, { target, profile: source }),
  });
  const merged = mergeTranslation(source, res.data);
  return { data: parseOutput(CandidateProfileSchema, normalizeProfile(merged, { clamp: true })), usage: res.usage, model: res.model };
}

function mergeTranslation(source: CandidateProfile, translated: ProfileWire): ProfileWire {
  const pick = <T extends { id: string }>(items: T[], id: string, where: string): T => {
    const found = items.find((item) => item.id === id);
    if (!found) throw new AiError('invalid_output', `a tradução não devolveu o item ${id} (${where})`);
    return found;
  };
  return {
    contact: { ...source.contact, location: translated.contact.location || source.contact.location },
    summary: translated.summary,
    experiences: source.experiences.map((e) => {
      const t = pick(translated.experiences, e.id, 'experiences');
      return {
        ...e,
        title: t.title,
        location: t.location || e.location,
        achievements: e.achievements.map((a) => ({ id: a.id, text: pick(t.achievements, a.id, 'achievements').text })),
      };
    }),
    education: source.education.map((e) => ({ ...e, degree: pick(translated.education, e.id, 'education').degree })),
    skills: source.skills.map((k) => ({ ...k, name: pick(translated.skills, k.id, 'skills').name })),
    languages: source.languages.map((l) => {
      const t = pick(translated.languages, l.id, 'languages');
      return { ...l, name: t.name, level: t.level };
    }),
    certifications: source.certifications.map((c) => ({ ...c, name: pick(translated.certifications, c.id, 'certifications').name })),
    links: source.links.map((l) => ({ ...l, label: pick(translated.links, l.id, 'links').label })),
  };
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
    maxOutputTokens: 300 + 150 * jobs.length,
    signal: opts.signal,
    ...buildPrompt('tier1', condenseProfile(profile), {
      jobs: jobs.map((j) => ({
        jobId: j.id, title: j.title, company: j.company, location: j.location,
        excerpt: clip(j.description, TIER1_EXCERPT_CHARS),
      })),
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
    maxOutputTokens: 8_000,
    signal: opts.signal,
    ...buildPrompt('tier2', profile, {
      job: { title: job.title, company: job.company, location: job.location, description: clip(job.description, TIER2_DESCRIPTION_CHARS) },
    }),
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
 */
export async function draftTailored(
  provider: AiProvider,
  profile: CandidateProfile,
  job: JobForAi,
  lang: ResumeLang,
  opts: { signal?: AbortSignal } = {},
): Promise<TaskResult<TailoredDraft>> {
  const res = await provider.generate({
    tier: 'strong',
    schema: TailoredDraftSchema,
    maxOutputTokens: 6_000,
    signal: opts.signal,
    ...buildPrompt('tier3', profile, {
      lang,
      job: { title: job.title, company: job.company, location: job.location, description: clip(job.description, TIER2_DESCRIPTION_CHARS) },
    }),
  });
  return { data: res.data, usage: res.usage, model: res.model };
}

/**
 * Idioma do currículo adaptado: vaga em português → pt-BR; qualquer outro idioma → inglês. Enquanto o
 * idioma da vaga não foi detectado (camadas 1 e 2 ainda não rodaram), vale o país da vaga.
 */
export function tailoredLangFor(jobLanguage: string | null | undefined, country?: 'BR' | 'INT'): ResumeLang {
  if (!jobLanguage) return country === 'BR' ? 'pt-BR' : 'en';
  return jobLanguage.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}
