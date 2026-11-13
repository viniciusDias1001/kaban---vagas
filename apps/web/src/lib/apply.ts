import {
  ACTIVE_APPLICATION_STATUSES,
  type AnswerScope, type AnswerSource, type AnswerValue, type ApplicationListItemDto, type ApplicationReason, type ApplicationStatus,
  type ApplyAiAnswers, type ApplyStatusDto, type PendingQuestion,
} from '@kv/shared/client';
import { errorMessage } from '../apiError';

/** Lógica pura das telas de candidatura automática (sem React). */

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  queued: 'Na fila',
  preparing: 'Preparando',
  filling: 'Preenchendo',
  waiting_human: 'Aguardando você',
  submitting: 'Enviando',
  submitted: 'Enviada',
  dry_run_ready: 'Ensaio pronto',
  needs_human: 'Precisa de você',
  skipped: 'Pulada',
  failed: 'Falhou',
  cancelled: 'Cancelada',
};

const REASON_TEXT: Record<ApplicationReason, string> = {
  question: 'Há perguntas do formulário que só você pode responder.',
  captcha: 'O site pediu para resolver um captcha.',
  verification_code: 'O site pediu um código de verificação.',
  login: 'A sessão no site expirou: entre de novo.',
  restricted: 'O site restringiu a conta; a candidatura automática foi pausada.',
  unsupported_form: 'O formulário tem um campo que a automação não sabe preencher.',
  resume_blocked: 'O currículo adaptado não passou na conferência.',
  confirm_submission: 'Não deu para confirmar se o envio foi concluído; confira no site antes de tentar de novo.',
  below_min_score: 'A nota da vaga ficou abaixo do mínimo configurado.',
  not_eligible: 'A vaga exige algo que o seu perfil não atende.',
  blocked: 'A empresa ou a vaga está na sua lista de bloqueio.',
  closed: 'A vaga não aceita mais candidaturas.',
  external: 'A candidatura é feita em um site externo, que a automação não cobre.',
  already_applied: 'Você já se candidatou a esta vaga.',
};

/** Frase em pt-BR para o motivo, com o detalhe quando há; '' sem motivo. */
export function reasonText(reason: ApplicationReason | null, detail: string | null): string {
  if (!reason) return '';
  const text = REASON_TEXT[reason];
  const extra = detail?.trim();
  return extra ? `${text.replace(/[.!?]$/, '')}: ${extra}` : text;
}

export type ApplicationFilter = 'active' | 'needs_human' | 'rehearsals' | 'submitted' | 'skipped';

const FILTER_MATCH: Record<ApplicationFilter, (status: ApplicationStatus) => boolean> = {
  active: (s) => (ACTIVE_APPLICATION_STATUSES as readonly string[]).includes(s),
  needs_human: (s) => s === 'needs_human',
  rehearsals: (s) => s === 'dry_run_ready',
  submitted: (s) => s === 'submitted',
  /** "Não enviadas": puladas, falhas e canceladas. */
  skipped: (s) => s === 'skipped' || s === 'failed' || s === 'cancelled',
};

export const FILTER_LABELS: Record<ApplicationFilter, string> = {
  active: 'Em andamento', needs_human: 'Precisam de você', rehearsals: 'Ensaios prontos', submitted: 'Enviadas', skipped: 'Não enviadas',
};

export function filterApplications(items: ApplicationListItemDto[], filter: ApplicationFilter): ApplicationListItemDto[] {
  return items.filter((item) => FILTER_MATCH[filter](item.status));
}

export function filterCounts(items: ApplicationListItemDto[]): Record<ApplicationFilter, number> {
  return {
    active: filterApplications(items, 'active').length,
    needs_human: filterApplications(items, 'needs_human').length,
    rehearsals: filterApplications(items, 'rehearsals').length,
    submitted: filterApplications(items, 'submitted').length,
    skipped: filterApplications(items, 'skipped').length,
  };
}

const RUNNING: readonly ApplicationStatus[] = ['preparing', 'filling', 'waiting_human', 'submitting'];

/** O selo do card. A marca da vaga manda; depois, o estado da candidatura. */
export function cardBadge(
  job: { appliedBy: 'ia' | 'humano' | null; needsHuman: boolean },
  status: ApplicationStatus | undefined,
): 'needs_human' | 'applying' | 'rehearsal' | 'applied_by_ai' | null {
  if (job.needsHuman) return 'needs_human';
  if (job.appliedBy === 'ia') return 'applied_by_ai';
  if (status && RUNNING.includes(status)) return 'applying';
  if (status === 'dry_run_ready') return 'rehearsal';
  return null;
}

export const SOURCE_LABELS: Record<AnswerSource, string> = {
  rule: 'regra', bank: 'sua resposta', profile: 'do perfil', written: 'escrita pela IA', blank: 'em branco',
};

/** Intervalo de releitura: 2 s com candidatura ativa ou espera ao vivo; 15 s caso contrário. */
export function applyPollMs(status: ApplyStatusDto | undefined): number {
  return status && (status.queued > 0 || status.waiting !== null) ? 2_000 : 15_000;
}

export const AI_ANSWER_LABELS: Record<ApplyAiAnswers, { title: string; hint: string }> = {
  off: { title: 'Desligado', hint: 'Só as regras e as suas respostas salvas respondem.' },
  review: { title: 'Com a sua aprovação', hint: 'A IA propõe; você aprova uma vez e a resposta fica salva.' },
  auto: { title: 'Automático', hint: 'A IA responde sem aprovação; a conferência é por texto e pode deixar passar exageros.' },
};

/** Rótulo curto da pendência. */
export const PENDING_KIND_LABELS: Record<PendingQuestion['kind'], string> = {
  unanswered: 'sem resposta',
  confirm_match: 'confirmar resposta salva',
  confirm_proposal: 'confirmar proposta da IA',
};

/** O que o dono fez em uma pendência: aceitou a proposta (`accept`) ou escreveu o `value`. */
export interface PendingDraft { questionId: string; accept: boolean; value: AnswerValue; scope: AnswerScope }

const isBlank = (value: AnswerValue): boolean =>
  value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

/** O corpo de PUT /applications/:id/answers. Pendência opcional deixada em branco e sem aceite fica de fora (a API recusa item vazio). */
export function toPendingAnswersBody(drafts: PendingDraft[]): {
  answers: { questionId: string; value: AnswerValue; scope: AnswerScope; confirmMatch: boolean }[];
} {
  return {
    answers: drafts
      .filter((d) => d.accept || !isBlank(d.value))
      .map((d) => ({ questionId: d.questionId, value: d.value, scope: d.scope, confirmMatch: d.accept })),
  };
}

/** Erro em pt-BR por pendência, pela id da pergunta; {} quando pode enviar. */
export function validatePendingDrafts(pending: PendingQuestion[], drafts: PendingDraft[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const p of pending) {
    const id = p.question.id;
    const draft = drafts.find((d) => d.questionId === id);
    if (draft?.accept) {
      if (p.kind === 'unanswered') errors[id] = 'Não há proposta para aceitar: escreva a resposta.';
      continue;
    }
    if (!draft || isBlank(draft.value)) {
      if (p.question.required) errors[id] = 'Responda esta pergunta ou aceite a proposta.';
      continue;
    }
    const { kind, options } = p.question;
    const values = Array.isArray(draft.value) ? draft.value : [draft.value];
    if ((kind === 'select' || kind === 'multiselect') && options.length > 0) {
      if (values.some((v) => typeof v !== 'string' || !options.includes(v))) errors[id] = 'Escolha uma das opções da lista.';
    } else if (kind === 'number') {
      const n = typeof draft.value === 'string' ? Number(draft.value.trim().replace(',', '.')) : NaN;
      if (!Number.isFinite(n)) errors[id] = 'Informe um número válido.';
    }
  }
  return errors;
}

/** Mensagens em pt-BR dos códigos `{ error }` que as rotas de candidatura devolvem. */
const ERROR_CODE_MESSAGES: Record<string, string> = {
  in_progress: 'A candidatura está em andamento agora. Espere terminar ou cancele antes de tentar de novo.',
  confirm_submission: 'Não dá para saber se o envio já foi feito. Confira no site e só então tente de novo.',
  not_rehearsal: 'Só um ensaio pronto pode ser enviado de verdade.',
  sent: 'Esta candidatura já foi enviada.',
  not_pending: 'Esta candidatura não está esperando respostas.',
  already_exists: 'Esta vaga já tem uma candidatura.',
  unsupported_site: 'Este site ainda não é atendido pela candidatura automática.',
  blocked: 'A empresa ou a vaga está na sua lista de bloqueio.',
  apply_unavailable: 'A candidatura automática só funciona com o app em endereço local.',
  apply_disabled: 'A candidatura automática está desligada nas configurações.',
  no_login: 'Este site não usa login.',
};

/** Texto para o dono quando uma rota de candidatura recusa: o código conhecido vira frase; o resto segue o tratamento geral. */
export function applyErrorMessage(status: number, bodyText: string): string {
  try {
    const code = (JSON.parse(bodyText) as { error?: unknown } | null)?.error;
    if (typeof code === 'string' && status >= 400 && status < 500 && ERROR_CODE_MESSAGES[code]) return ERROR_CODE_MESSAGES[code];
  } catch {
    /* corpo que não é JSON */
  }
  return errorMessage(status, bodyText);
}
