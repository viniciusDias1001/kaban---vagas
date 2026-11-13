/**
 * Contrato do e-mail que NÃO depende de Zod: constantes, tipos, DTOs e helpers puros. É o que o navegador
 * recebe por `@kv/shared/client`. Nada aqui pode importar `./schemas` em tempo de execução (só `import type`).
 * Os schemas de validação ficam em `email.ts`.
 */
import type { Column } from './constants';

export const EMAIL_KINDS = ['recebimento', 'reprovacao', 'entrevista', 'oferta', 'pedido', 'outro'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];
export const EMAIL_KIND_LABELS: Record<EmailKind, string> = {
  recebimento: 'Recebimento', reprovacao: 'Reprovação', entrevista: 'Entrevista', oferta: 'Oferta', pedido: 'Pedido', outro: 'Outro',
};
export const DECISIVE_KINDS = ['reprovacao', 'entrevista', 'oferta'] as const;
export type DecisiveKind = (typeof DECISIVE_KINDS)[number];

export const KNOWN_FACTS = ['phone', 'email', 'location', 'linkedin', 'github', 'portfolio', 'salary', 'start_availability',
  'visa_sponsorship', 'work_authorization', 'work_models', 'relocation', 'pronouns', 'resume'] as const;
export type KnownFact = (typeof KNOWN_FACTS)[number];
export const KNOWN_FACT_LABELS: Record<KnownFact, string> = {
  phone: 'Telefone', email: 'E-mail', location: 'Cidade', linkedin: 'LinkedIn', github: 'GitHub', portfolio: 'Portfólio',
  salary: 'Pretensão salarial', start_availability: 'Disponibilidade para começar', visa_sponsorship: 'Patrocínio de visto',
  work_authorization: 'Autorização de trabalho', work_models: 'Modelo de trabalho', relocation: 'Mudança de cidade',
  pronouns: 'Pronomes', resume: 'Currículo',
};
export interface EmailRequest { fact: KnownFact | 'outro'; note: string }
export type EmailLang = 'pt-BR' | 'en';

export const REPLY_STATES = ['rascunho', 'aprovada', 'enviando', 'enviada', 'falhou', 'descartada'] as const;
export type ReplyState = (typeof REPLY_STATES)[number];
export type ReplyOrigin = 'facts' | 'ai';

export const ALERT_KINDS = ['interview', 'offer', 'missing_fact', 'draft', 'move_confirm', 'unmatched', 'mailbox_error',
  'backfill_summary', 'budget_waiting'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const EMAIL_MOVE_MODES = ['auto', 'confirm'] as const;
export type EmailMoveMode = (typeof EMAIL_MOVE_MODES)[number];
export const EMAIL_FACTS_MODES = ['auto', 'approve', 'off'] as const;
export type EmailFactsMode = (typeof EMAIL_FACTS_MODES)[number];
export interface EmailConfig { enabled: boolean; moveMode: EmailMoveMode; factsMode: EmailFactsMode; aiDrafts: boolean }
export const EMAIL_DEFAULTS: EmailConfig = { enabled: true, moveMode: 'auto', factsMode: 'auto', aiDrafts: true };

export const MAIL_LIMITS = { bodyChars: 12_000, subjectChars: 300, summaryChars: 200, draftChars: 4_000, candidates: 5,
  candidateDays: 120, backfillDays: 30, ignoredDays: 30, pollMs: 180_000, fetchBatch: 50 } as const;
/** Lacuna que a IA deixa onde falta um dado; rascunho com lacuna não pode ser enviado. */
export const DRAFT_PLACEHOLDER = /\[\[[^\]]*\]\]/;

export type SecretName = 'mail_password' | 'telegram_bot_token';

/** A função só existe com HOST local; mesma regra de `applyAvailability`. */
export function emailAvailability(env: { HOST?: string }): { available: boolean; reason: string | null } {
  const host = env.HOST?.trim();
  if (!host || host === '127.0.0.1' || host === 'localhost' || host === '::1') return { available: true, reason: null };
  return {
    available: false,
    reason: 'O e-mail só funciona com o app em endereço local (HOST 127.0.0.1, localhost ou ::1).',
  };
}

export interface JobMailMarks { confirmed: boolean; badge: 'entrevista' | 'oferta' | 'pedido' | null }
export const NO_MAIL_MARKS: JobMailMarks = { confirmed: false, badge: null };

export interface MailAccountDto {
  connected: boolean; address: string | null; connectedAt: number | null; lastReadAt: number | null;
  paused: boolean; error: string | null; available: boolean; unavailableReason: string | null;
  canStore: boolean; secretProblem: string | null; profileEmail: string | null; differsFromProfile: boolean;
}
export interface MailMessageDto {
  id: number; threadKey: string; direction: 'in' | 'out'; fromAddress: string; fromName: string; toAddress: string;
  subject: string; sentAt: number; body: string; kind: EmailKind | null; summary: string | null; lang: EmailLang | null;
  requests: EmailRequest[]; jobId: number | null; company: string | null; jobTitle: string | null;
  linkedBy: 'auto' | 'owner' | null; corrected: boolean; backfill: boolean;
  /** A coluna para onde este e-mail moveu o card, e se ainda dá para desfazer. */
  movedTo: Column | null; canUndoMove: boolean;
}
export interface MailReplyDto {
  id: number; messageId: number; origin: ReplyOrigin; items: KnownFact[]; toAddress: string; subject: string; body: string;
  attachResume: boolean; state: ReplyState; note: string | null; createdAt: number; sentAt: number | null;
}
export interface JobEmailsDto { messages: MailMessageDto[]; replies: MailReplyDto[] }
export interface MailIgnoredDto { id: number; fromAddress: string; fromName: string; subject: string; sentAt: number; company: string; promoted: boolean }
export interface AlertPayload {
  moveTo?: Column; missing?: KnownFact[]; counts?: Partial<Record<EmailKind, number>>; total?: number; waiting?: number;
  recipient?: string; reason?: string;
}
export interface AlertDto {
  id: number; kind: AlertKind; jobId: number | null; company: string | null; jobTitle: string | null;
  messageId: number | null; replyId: number | null; subject: string | null; summary: string | null;
  payload: AlertPayload; createdAt: number;
}
