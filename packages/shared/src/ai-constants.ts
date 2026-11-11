/**
 * Parte de `@kv/shared` sobre IA que NÃO depende de Zod: constantes, tipos, DTOs e helpers puros. É o
 * que o navegador recebe por `@kv/shared/client`. Os schemas de validação ficam em `ai.ts`.
 */
import type { CandidateProfile, JobAnalysis, TailoredDraft } from './ai';

// ---------------------------------------------------------------------------------------------
// Currículo e perfil do candidato. ("Perfil" sozinho, no resto do código, é o perfil de BUSCA.)
// ---------------------------------------------------------------------------------------------

export const RESUME_LANGS = ['pt-BR', 'en'] as const;
export type ResumeLang = (typeof RESUME_LANGS)[number];
export const otherLang = (lang: ResumeLang): ResumeLang => (lang === 'pt-BR' ? 'en' : 'pt-BR');

export type ProfileOrigin = 'extraido' | 'traduzido' | 'editado';

/** Prefixo do identificador estável de cada tipo de item do perfil. */
export const ITEM_PREFIXES = {
  experience: 'exp',
  achievement: 'ach',
  education: 'edu',
  skill: 'skill',
  language: 'lang',
  certification: 'cert',
  link: 'link',
} as const;
export type ItemKind = keyof typeof ITEM_PREFIXES;

export const itemIdPattern = (kind: ItemKind) => new RegExp(`^${ITEM_PREFIXES[kind]}_[a-z0-9]{8}$`);

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Identificador novo, ex.: `exp_k3j9x0aq`. `crypto` é global no Node e no navegador. */
export function randomItemId(kind: ItemKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${ITEM_PREFIXES[kind]}_${[...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')}`;
}

/** Currículo adaptado já resolvido: empresa, cargo, datas etc. copiados do perfil pelo servidor. */
export interface TailoredResume {
  lang: ResumeLang;
  contact: CandidateProfile['contact'];
  summary: string;
  experiences: (Omit<CandidateProfile['experiences'][number], 'achievements'> & {
    achievements: { sourceId: string; text: string }[];
  })[];
  education: CandidateProfile['education'];
  skills: CandidateProfile['skills'];
  languages: CandidateProfile['languages'];
  certifications: CandidateProfile['certifications'];
  links: CandidateProfile['links'];
}

/** O rascunho (referências + textos) equivalente a um currículo resolvido: é o que o editor envia de volta. */
export function draftOf(resume: TailoredResume): TailoredDraft {
  return {
    summary: resume.summary,
    experiences: resume.experiences.map((e) => ({
      id: e.id,
      achievements: e.achievements.map((a) => ({ sourceId: a.sourceId, text: a.text })),
    })),
    educationIds: resume.education.map((e) => e.id),
    skillIds: resume.skills.map((k) => k.id),
    languageIds: resume.languages.map((l) => l.id),
    certificationIds: resume.certifications.map((c) => c.id),
    linkIds: resume.links.map((l) => l.id),
  };
}

/**
 * `novel_term`: nome próprio, sigla ou termo técnico que não está no perfil; `unrelated_text`: realização
 * reescrita sem relação com a original; `limit`: tamanho, quantidade ou caractere de controle fora do permitido.
 */
export const VIOLATION_CODES = [
  'unknown_id', 'duplicate_id', 'new_number', 'foreign_company', 'novel_term', 'unrelated_text', 'limit',
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export interface Violation {
  code: ViolationCode;
  /** Onde, no rascunho: "experiences[0].achievements[1].text". */
  path: string;
  message: string;
  /** O termo ou número que divergiu, quando há um (ex.: "Kubernetes", "40x"). */
  detail?: string;
}

// ---------------------------------------------------------------------------------------------
// Fila, uso e DTOs
// ---------------------------------------------------------------------------------------------

export const AI_TASK_TYPES = ['profile_extract', 'profile_translate', 'tier1', 'tier2', 'tier3'] as const;
export type AiTaskType = (typeof AI_TASK_TYPES)[number];
export type AiTaskStatus = 'queued' | 'running' | 'ok' | 'error' | 'blocked_budget';
/** `test` = chamadas do botão "Testar conexão". */
export const AI_LAYERS = ['profile', 'tier1', 'tier2', 'tier3', 'test'] as const;
export type AiLayer = (typeof AI_LAYERS)[number];

/** Estado de uma camada para a interface. `stale` = existe resultado, mas de uma versão antiga do perfil. */
export type LayerState = 'none' | 'queued' | 'running' | 'ok' | 'stale' | 'error' | 'blocked_budget';

export interface AiTaskDto {
  id: number;
  type: AiTaskType;
  status: AiTaskStatus;
  attempts: number;
  error: string | null;
  jobId: number | null;
  lang: ResumeLang | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface AiStatusDto {
  configured: boolean;
  /** Por que não está configurada (variável ausente ou inválida); null quando está. */
  problem: string | null;
  provider: string | null;
  models: { fast: string; strong: string } | null;
  /** A análise (camada 2) dispara sozinha ao abrir a vaga ou movê-la; false = só pelo botão. */
  tier2Auto: boolean;
  budget: { dailyUsd: number; spentTodayUsd: number; exceeded: boolean; timeZone: string };
}

export type UsageByLayer = Record<AiLayer, number>;
export interface AiUsageDto {
  /** Custo estimado em US$, por camada. */
  today: UsageByLayer;
  last30Days: UsageByLayer;
}

export interface ResumeMetaDto {
  lang: ResumeLang;
  fileName: string;
  mime: string;
  size: number;
  uploadedAt: number;
}

export interface CandidateProfileDto {
  lang: ResumeLang;
  data: CandidateProfile;
  origin: ProfileOrigin;
  version: number;
  updatedAt: number;
}

export interface ProfileOverviewDto {
  resumes: ResumeMetaDto[];
  profiles: CandidateProfileDto[];
  /** A tarefa de perfil mais recente de cada idioma (extração ou tradução). */
  tasks: AiTaskDto[];
}

export interface JobAiSummaryDto {
  jobId: number;
  language: string | null;
  titlePt: string | null;
  score: number | null;
  reason: string | null;
  /** A nota foi calculada com uma versão anterior do perfil. */
  stale: boolean;
}

export interface LayerDto {
  state: LayerState;
  /** A tarefa mais recente da camada para esta vaga (traz o erro e o id para confirmar o gasto). */
  task: AiTaskDto | null;
}

export interface JobAiDetailDto {
  summary: JobAiSummaryDto | null;
  tier1: LayerDto;
  tier2: LayerDto;
  descriptionPt: string | null;
  analysis: JobAnalysis | null;
  /** false quando a fonte não entregou descrição e a busca sob demanda falhou. */
  descriptionAvailable: boolean;
}

export interface TailoredDto {
  jobId: number;
  lang: ResumeLang;
  content: TailoredResume;
  profileVersion: number;
  stale: boolean;
  createdAt: number;
  editedAt: number | null;
}

export interface TailoredStateDto extends LayerDto {
  tailored: TailoredDto | null;
}

export interface TailoredSaveDto {
  tailored: TailoredDto;
  /** Avisos que não impedem salvar (ex.: número que não está no perfil): o texto agora é do usuário. */
  warnings: Violation[];
}
