/**
 * Parte de `@kv/shared` sobre candidatura automática que NÃO depende de Zod: constantes, tipos, DTOs e helpers
 * puros. É o que o navegador recebe por `@kv/shared/client`. Os schemas de validação ficam em `apply.ts`.
 */

export const APPLY_SITE_IDS = ['linkedin', 'greenhouse', 'lever', 'fake'] as const;
export type ApplySiteId = (typeof APPLY_SITE_IDS)[number];
export const APPLY_SITE_LABELS: Record<ApplySiteId, string> = {
  linkedin: 'LinkedIn', greenhouse: 'Greenhouse', lever: 'Lever', fake: 'Site de teste',
};

export const APPLICATION_STATUSES = ['queued', 'preparing', 'filling', 'waiting_human', 'submitting', 'submitted',
  'dry_run_ready', 'needs_human', 'skipped', 'failed', 'cancelled'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const ACTIVE_APPLICATION_STATUSES = ['queued', 'preparing', 'filling', 'waiting_human', 'submitting'] as const;
export const NEEDS_HUMAN_REASONS = ['question', 'captcha', 'verification_code', 'login', 'restricted',
  'unsupported_form', 'resume_blocked', 'confirm_submission'] as const;
export type NeedsHumanReason = (typeof NEEDS_HUMAN_REASONS)[number];
export const SKIP_REASONS = ['below_min_score', 'not_eligible', 'blocked', 'closed', 'external', 'already_applied'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export type ApplicationReason = NeedsHumanReason | SkipReason;
export type ApplyMode = 'dry_run' | 'real';
export type ApplyTrigger = 'auto' | 'manual';
export type ApplyResumeMode = 'tailored' | 'base';
export type ShotKind = 'filled' | 'confirmation' | 'blocked';
export type SiteSession = 'unknown' | 'logged_in' | 'logged_out';
export type SitePauseReason = 'brake' | 'restricted' | 'owner_away';

export const QUESTION_KINDS = ['text', 'longtext', 'number', 'date', 'select', 'multiselect', 'boolean', 'file'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const QUESTION_CATEGORIES = ['identity', 'file', 'origin', 'profile_fact', 'personal', 'demographic',
  'consent', 'open', 'unknown'] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];
export type AnswerSource = 'rule' | 'bank' | 'profile' | 'written' | 'blank';
export type AnswerValue = string | string[] | boolean | null;
export type AnswerScope = 'always' | 'company' | 'job';

export interface Question {
  id: string; label: string; help: string; kind: QuestionKind; options: string[]; required: boolean; maxLength: number | null;
}
export interface ResolvedAnswer {
  questionId: string; value: AnswerValue; source: AnswerSource; category: QuestionCategory;
  /** Ids de itens do perfil citados (fatos do perfil). */
  basis: string[];
  bankAnswerId: number | null;
}
/** O que fica gravado na candidatura: a resposta com a pergunta como apareceu. */
export interface AnswerRecord extends ResolvedAnswer { label: string; kind: QuestionKind; options: string[]; required: boolean }
export interface PendingQuestion {
  question: Question; category: QuestionCategory;
  /** `unanswered`: falta resposta. `confirm_match`: o modelo propôs uma resposta salva e o dono precisa confirmar. */
  kind: 'unanswered' | 'confirm_match';
  proposal: { bankAnswerId: number; bankQuestion: string; value: string } | null;
}

export const APPLY_DEFAULTS = {
  minScore: 70,
  dailyCaps: { linkedin: 10, greenhouse: 15, lever: 15, fake: 15, total: 30, linkedinViews: 30 },
  companyCap: 2, companyCapDays: 30,
  window: { start: '08:00', end: '21:00' },
  maxJobAgeDays: 14,
} as const;
export const APPLY_TIMING = {
  sweepMs: 300_000, humanWaitMs: 600_000, workTimeoutMs: 600_000, retryMs: [300_000, 1_800_000],
  browserIdleMs: 300_000,
  formIntervalMs: { linkedin: [180_000, 480_000], other: [60_000, 180_000], fake: [0, 0] },
  viewIntervalMs: [60_000, 180_000],
  brakeAfter: 3, ownerAwayAfter: 2, shotRetentionDays: 90,
} as const;

/** Minúsculas, sem acento, sem pontuação, espaços colapsados: a chave do casamento exato de perguntas. */
export function normalizeQuestionText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function isActiveApplication(status: ApplicationStatus): boolean {
  return (ACTIVE_APPLICATION_STATUSES as readonly string[]).includes(status);
}

/** A função só existe com HOST local: ausente, `127.0.0.1`, `localhost` ou `::1`. */
export function applyAvailability(env: { HOST?: string }): { available: boolean; reason: string | null } {
  const host = env.HOST?.trim();
  if (!host || host === '127.0.0.1' || host === 'localhost' || host === '::1') return { available: true, reason: null };
  return {
    available: false,
    reason: 'A candidatura automática só funciona com o app em endereço local (HOST 127.0.0.1, localhost ou ::1).',
  };
}

export interface ApplicationEventDto { status: ApplicationStatus; message: string | null; at: number }
export interface ApplicationDto {
  id: number; jobId: number; site: ApplySiteId; status: ApplicationStatus; reason: ApplicationReason | null;
  detail: string | null; trigger: ApplyTrigger; mode: ApplyMode; gateScore: number | null;
  resumeLang: 'pt-BR' | 'en' | null; resumeFileName: string | null; hasResume: boolean;
  answers: AnswerRecord[]; pendingQuestions: PendingQuestion[]; confirmation: string | null; shots: ShotKind[];
  attempts: number; createdAt: number; startedAt: number | null; submittedAt: number | null; finishedAt: number | null;
  events: ApplicationEventDto[];
}
export interface ApplicationListItemDto {
  id: number; jobId: number; jobTitle: string; company: string; site: ApplySiteId; status: ApplicationStatus;
  reason: ApplicationReason | null; detail: string | null; mode: ApplyMode; gateScore: number | null;
  pendingCount: number; createdAt: number; submittedAt: number | null;
}
export interface ApplySiteStateDto {
  site: ApplySiteId; label: string; needsLogin: boolean; mode: ApplyMode; session: SiteSession;
  sessionCheckedAt: number | null; paused: boolean; pauseReason: SitePauseReason | null;
  formsToday: number; formsCap: number; viewsToday: number | null; viewsCap: number | null;
}
export interface ApplyStatusDto {
  available: boolean; unavailableReason: string | null; enabled: boolean; withinWindow: boolean;
  sites: ApplySiteStateDto[]; totalToday: number; totalCap: number; queued: number; needsHuman: number;
  /** Há uma espera ao vivo agora (captcha, código, login): a tela avisa o dono. */
  waiting: { applicationId: number; jobId: number; gate: string } | null;
}
export interface ApplyAnswerDto {
  id: number; question: string; key: string | null; answer: string; kind: 'text' | 'number' | 'boolean' | 'choice';
  scope: AnswerScope; scopeValue: string | null; country: string | null;
  aliases: { normalized: string; options: string[]; value: string }[]; usedCount: number; updatedAt: number;
}
