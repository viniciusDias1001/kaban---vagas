import {
  NUMBER_FORMAT_PROBLEM,
  type AnswerScope, type AnswerSource, type AnswerValue, type ApplicationFilter, type ApplicationListItemDto, type ApplicationReason,
  type ApplicationStatus, type ApplicationDto, type ApplyAiAnswers, type ApplyAnswerDto, type ApplyStatusDto, type Column,
  type JobApplicationDto, type PendingQuestion, type Question, type ShotKind, bankBoolean, bankList, bankText, isAppliedOrLater,
  parseNumberAnswer,
} from '@kv/shared/client';
import { errorMessage } from '../apiError';
import type { ApplyAnswerInput } from '../applyApi';

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

/** O envio começou e o site não confirmou: o dono confere, e não há "Tentar de novo". */
export const UNCONFIRMED_TEXT = 'O envio foi iniciado e o site não confirmou. Confira no site ou no seu e-mail se a candidatura chegou.';

const REASON_TEXT: Record<ApplicationReason, string> = {
  question: 'Há perguntas do formulário que só você pode responder.',
  captcha: 'O site pediu para resolver um captcha.',
  verification_code: 'O site pediu um código de verificação.',
  login: 'A sessão no site expirou: entre de novo.',
  restricted: 'O site restringiu a conta; a candidatura automática foi pausada.',
  unsupported_form: 'O formulário tem um campo que a automação não sabe preencher.',
  resume_blocked: 'O currículo adaptado não passou na conferência.',
  confirm_submission: UNCONFIRMED_TEXT,
  below_min_score: 'A nota da vaga ficou abaixo do mínimo configurado.',
  not_eligible: 'A vaga exige algo que o seu perfil não atende.',
  blocked: 'A empresa ou a vaga está na sua lista de bloqueio.',
  closed: 'A vaga não aceita mais candidaturas.',
  external: 'A candidatura é feita em um site externo, que a automação não cobre.',
  already_applied: 'Você já se candidatou a esta vaga por conta própria; a IA não envia de novo.',
};

/** O rótulo de uma candidatura que terminou porque o dono marcou a vaga como aplicada. */
export const APPLIED_BY_OWNER_LABEL = 'Aplicada por você';

/** O nome do estado na tela; uma pulada porque o dono já aplicou lê "Aplicada por você". */
export function statusLabel(status: ApplicationStatus, reason: ApplicationReason | null): string {
  return status === 'skipped' && reason === 'already_applied' ? APPLIED_BY_OWNER_LABEL : STATUS_LABELS[status];
}

/** A vaga já foi aplicada: o card está em Aplicada ou depois, ou a vaga tem a marca de quem aplicou. */
export function jobAlreadyApplied(job: { column: Column; appliedBy: 'ia' | 'humano' | null }): boolean {
  return isAppliedOrLater(job.column) || job.appliedBy !== null;
}

/** Frase em pt-BR para o motivo, com o detalhe quando há; '' sem motivo. */
export function reasonText(reason: ApplicationReason | null, detail: string | null): string {
  if (!reason) return '';
  const text = REASON_TEXT[reason];
  const extra = detail?.trim();
  return extra ? `${text.replace(/[.!?]$/, '')}: ${extra}` : text;
}

/** Os rótulos dos filtros da aba (os filtros e os estados de cada um vêm de `@kv/shared`). */
export const FILTER_LABELS: Record<ApplicationFilter, string> = {
  active: 'Em andamento', needs_human: 'Precisam de você', rehearsals: 'Ensaios prontos', submitted: 'Enviadas', skipped: 'Não enviadas',
};

/** A resposta de GET /applications?filter=: as linhas do filtro (as 200 mais novas) e as contagens de todos os filtros. */
export interface ApplicationListDto { items: ApplicationListItemDto[]; counts: Record<ApplicationFilter, number> }

/** A frase sob a lista quando o filtro tem mais candidaturas do que a página mostra; null quando mostra todas. */
export function listCutText(shown: number, total: number): string | null {
  return shown < total ? `Mostrando as ${shown} mais recentes de ${total}.` : null;
}

/** Uma linha em qualquer lista de filtro já carregada (o aviso da espera ao vivo e a notificação procuram o nome da vaga). */
export function findListItem(
  lists: readonly ({ items: ApplicationListItemDto[] } | undefined)[], id: number,
): ApplicationListItemDto | undefined {
  for (const list of lists) {
    const hit = list?.items.find((a) => a.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * "Enviar todos os ensaios": manda os ids dos ensaios prontos que a aba carregou (as 200 mais novas), nunca "todos" às
 * cegas. `hidden` é quantos ensaios prontos existem além desses (o diálogo diz que ficam para depois).
 */
export function sendAllPlan(rehearsals: ApplicationListItemDto[] | undefined, total: number): { ids: number[]; hidden: number } {
  const ids = (rehearsals ?? []).filter((a) => a.status === 'dry_run_ready').map((a) => a.id);
  return { ids, hidden: Math.max(0, total - ids.length) };
}

/** O que dizer depois do envio de todos: só quando algum ensaio não foi enviado (mudou de estado ou a vaga já foi aplicada). */
export function sendAllResultText(result: { queued: number; skipped: number }): string | null {
  if (result.skipped === 0) return null;
  const queued = result.queued === 0
    ? 'Nenhuma candidatura foi enviada.'
    : result.queued === 1 ? '1 candidatura foi para a fila de envio.' : `${result.queued} candidaturas foram para a fila de envio.`;
  const skipped = result.skipped === 1
    ? '1 não foi enviada porque deixou de ser um ensaio pronto ou a vaga já foi aplicada.'
    : `${result.skipped} não foram enviadas porque deixaram de ser ensaios prontos ou a vaga já foi aplicada.`;
  return `${queued} ${skipped}`;
}

/** Os estados em que o worker está mexendo na candidatura agora. */
export const RUNNING_STATUSES: readonly ApplicationStatus[] = ['preparing', 'filling', 'waiting_human', 'submitting'];

/** O selo do card. A marca da vaga manda; depois, o estado da candidatura da vaga (vem na lista de vagas). */
export function cardBadge(
  job: { appliedBy: 'ia' | 'humano' | null; needsHuman: boolean; applicationStatus: ApplicationStatus | null },
): 'needs_human' | 'applying' | 'rehearsal' | 'applied_by_ai' | null {
  const status = job.applicationStatus;
  if (job.needsHuman) return 'needs_human';
  if (job.appliedBy === 'ia') return 'applied_by_ai';
  if (status && RUNNING_STATUSES.includes(status)) return 'applying';
  if (status === 'dry_run_ready') return 'rehearsal';
  return null;
}

export const ANSWER_SOURCE_LABELS: Record<AnswerSource, string> = {
  rule: 'regra', bank: 'sua resposta', profile: 'do perfil', written: 'escrita pela IA', blank: 'em branco',
};

/** Intervalo de releitura: 2 s com candidatura na fila, em andamento ou com espera ao vivo; 15 s caso contrário. */
export function applyPollMs(status: ApplyStatusDto | undefined): number {
  return status && (status.queued > 0 || status.running > 0 || status.waiting !== null) ? 2_000 : 15_000;
}

/**
 * O que, no estado, muda as listas de candidaturas: as contagens da fila e a espera ao vivo. Mudou, as listas são
 * relidas na hora (sem isto, quando a fila para, elas esperam o intervalo de 15 s). Null antes do primeiro estado.
 */
export function queueSignature(status: ApplyStatusDto | undefined): string | null {
  if (!status) return null;
  return `${status.queued}:${status.running}:${status.needsHuman}:${status.waiting ? `${status.waiting.applicationId}:${status.waiting.gate}` : ''}`;
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

/** Perguntas de arquivo: o app não envia arquivos por aqui, então elas nunca são validadas nem enviadas. */
const fileQuestionIds = (pending: PendingQuestion[]): Set<string> =>
  new Set(pending.filter((p) => p.question.kind === 'file').map((p) => p.question.id));

/** O texto no lugar do campo de uma pergunta de arquivo. */
export function fileQuestionText(required: boolean): string {
  return required
    ? 'Esta pergunta pede um arquivo: responda direto no site da vaga.'
    : 'Pede um arquivo: é opcional e fica em branco.';
}

/**
 * O corpo de PUT /applications/:id/answers. Pendência opcional deixada em branco e sem aceite fica de fora (a API recusa
 * item vazio), e pergunta de arquivo também.
 */
export function toPendingAnswersBody(pending: PendingQuestion[], drafts: PendingDraft[]): {
  answers: { questionId: string; value: AnswerValue; scope: AnswerScope; confirmMatch: boolean }[];
} {
  const files = fileQuestionIds(pending);
  return {
    answers: drafts
      .filter((d) => !files.has(d.questionId) && (d.accept || !isBlank(d.value)))
      .map((d) => ({ questionId: d.questionId, value: d.value, scope: d.scope, confirmMatch: d.accept })),
  };
}

/** Erro em pt-BR por pendência, pela id da pergunta; {} quando pode enviar. Pergunta de arquivo não é validada. */
export function validatePendingDrafts(pending: PendingQuestion[], drafts: PendingDraft[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const p of pending) {
    const id = p.question.id;
    if (p.question.kind === 'file') continue;
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
      if (typeof draft.value !== 'string' || parseNumberAnswer(draft.value) === null) errors[id] = NUMBER_FORMAT_PROBLEM;
    }
  }
  return errors;
}

/** Os pedidos de conta que a linha de um site faz ao worker. */
export type AccountAction = 'open' | 'check' | 'logout';

/** O que importa de uma mutação do React Query para a resposta ao clique. */
export interface AccountMutationView {
  isPending: boolean; isSuccess: boolean; isError: boolean; error: { message: string } | null; variables: unknown;
}

export type AccountFeedback = { kind: 'idle' } | { kind: 'pending' } | { kind: 'sent' } | { kind: 'error'; message: string };

/**
 * A resposta mostrada na linha do site: só a do último botão clicado. Cada mutação guarda o próprio erro; sem isto,
 * um erro antigo de "Abrir" esconderia o "Pedido enviado." de um "Verificar" que deu certo depois.
 */
export function accountFeedback(
  last: AccountAction | null, site: string, states: Record<AccountAction, AccountMutationView>,
): AccountFeedback {
  if (!last) return { kind: 'idle' };
  const m = states[last];
  if (m.variables !== site) return { kind: 'idle' };
  if (m.isPending) return { kind: 'pending' };
  if (m.isError) return { kind: 'error', message: m.error?.message ?? 'Não foi possível enviar o pedido.' };
  if (m.isSuccess) return { kind: 'sent' };
  return { kind: 'idle' };
}

/** Mensagens em pt-BR dos códigos `{ error }` que as rotas de candidatura devolvem. */
const ERROR_CODE_MESSAGES: Record<string, string> = {
  in_progress: 'A candidatura está em andamento agora. Espere terminar ou cancele antes de tentar de novo.',
  confirm_submission: 'Não dá para saber se o envio já foi feito. Confira no site; se já enviou, mova o card para Aplicada, senão cancele.',
  not_rehearsal: 'Só um ensaio pronto pode ser enviado de verdade.',
  sent: 'Esta candidatura já foi enviada.',
  not_pending: 'Esta candidatura não está esperando respostas.',
  already_exists: 'Esta vaga já tem uma candidatura.',
  already_applied: 'Você já se candidatou a esta vaga (o card está em Aplicada ou depois): a IA não envia de novo.',
  unsupported_site: 'Este site ainda não é atendido pela candidatura automática.',
  blocked: 'A empresa ou a vaga está na sua lista de bloqueio.',
  apply_unavailable: 'A candidatura automática não está disponível agora.',
  apply_disabled: 'A candidatura automática está desligada nas configurações.',
  no_login: 'Este site não usa login.',
  not_cancellable: 'Esta candidatura já terminou.',
};

/**
 * Códigos cuja mensagem do servidor diz mais que a nossa: o item da lista de bloqueio que bateu, o que fazer com um envio
 * não confirmado, o motivo de o worker não poder rodar. Para eles a mensagem da API passa; sem mensagem, vale a nossa.
 */
const SERVER_DETAIL_CODES = new Set(['confirm_submission', 'blocked', 'apply_unavailable']);

/** Texto para o dono quando uma rota de candidatura recusa: o código conhecido vira frase; o resto segue o tratamento geral. */
export function applyErrorMessage(status: number, bodyText: string): string {
  try {
    const body = JSON.parse(bodyText) as { error?: unknown; message?: unknown } | null;
    const code = body?.error;
    if (typeof code === 'string' && status >= 400 && status < 500 && ERROR_CODE_MESSAGES[code]) {
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (SERVER_DETAIL_CODES.has(code) && message !== '') return message.charAt(0).toUpperCase() + message.slice(1);
      return ERROR_CODE_MESSAGES[code];
    }
  } catch {
    /* corpo que não é JSON */
  }
  return errorMessage(status, bodyText);
}

/**
 * O aviso de "não disponível" (Configurações e aba Candidaturas). Quando o motivo é o do worker (navegador ausente, por
 * exemplo), as configurações continuam editáveis; fora de endereço local, ficam travadas. Null quando está disponível.
 */
export function unavailableNotice(status: ApplyStatusDto | undefined): { title: string; reason: string; lockSettings: boolean } | null {
  if (!status || status.available) return null;
  const reason = status.unavailableReason ?? 'A candidatura automática não está disponível.';
  const fromWorker = status.worker !== null && !status.worker.available && status.worker.reason === status.unavailableReason;
  return fromWorker
    ? { title: 'O worker não consegue se candidatar agora', reason, lockSettings: false }
    : { title: 'Indisponível neste endereço', reason, lockSettings: true };
}

/* ---- Aba Candidaturas e seção "Candidatura" do painel da vaga ---- */

/** Ordem em que a aba procura um filtro com candidaturas ao abrir: o que pede o dono vem primeiro. */
const FILTER_PRIORITY: readonly ApplicationFilter[] = ['needs_human', 'active', 'rehearsals', 'submitted', 'skipped'];

/** O filtro em que a aba abre quando ninguém escolheu: o primeiro com candidaturas; "Em andamento" se não há nenhuma. */
export function firstFilterWithItems(counts: Record<ApplicationFilter, number>): ApplicationFilter {
  return FILTER_PRIORITY.find((f) => counts[f] > 0) ?? 'active';
}

/** Os botões que cada estado mostra no painel da vaga. */
export interface ApplicationActions {
  /** "Enviar de verdade": só ensaio pronto. */
  send: boolean;
  /** "Tentar de novo": parada (menos o envio não confirmado), falha, pulada ou cancelada. */
  retry: boolean;
  /** "Cancelar": todo estado que não é final. */
  cancel: boolean;
  /** Em andamento: o cancelamento vale no próximo ponto seguro, e um envio já iniciado pode concluir. */
  cancelLater: boolean;
  /** "Já apliquei por conta própria": o envio começou e o site não confirmou. */
  alreadyApplied: boolean;
  /** O cancelamento já foi pedido e vale no próximo ponto seguro: o botão fica desligado e a tela diz isso. */
  cancelPending: boolean;
}

/** Os botões do painel. Vaga já aplicada (coluna Aplicada ou depois, ou marca de quem aplicou): nada de tentar ou enviar de novo. */
export function applicationActions(
  app: { status: ApplicationStatus; reason: ApplicationReason | null; cancelRequested: boolean },
  job: { column: Column; appliedBy: 'ia' | 'humano' | null },
): ApplicationActions {
  const applied = jobAlreadyApplied(job);
  const unconfirmed = app.status === 'needs_human' && app.reason === 'confirm_submission';
  const running = RUNNING_STATUSES.includes(app.status);
  const cancel = app.status === 'queued' || running || app.status === 'needs_human' || app.status === 'dry_run_ready';
  return {
    send: !applied && app.status === 'dry_run_ready',
    retry: !applied
      && ((app.status === 'needs_human' && !unconfirmed) || app.status === 'failed' || app.status === 'skipped' || app.status === 'cancelled'),
    cancel,
    cancelLater: running,
    alreadyApplied: unconfirmed,
    cancelPending: cancel && app.cancelRequested,
  };
}

/** O que a seção "Candidatura" do painel mostra: nada, o convite "Aplicar com IA" ou a candidatura. */
export function applySectionView(data: JobApplicationDto | null | undefined): 'hidden' | 'offer' | 'application' {
  if (!data) return 'hidden'; // carregando, ou a vaga não existe mais
  if (data.application) return 'application';
  // Site não atendido, vaga já aplicada, bloqueada, função desligada ou indisponível: o painel fica como era.
  return data.canApply ? 'offer' : 'hidden';
}

/** A resposta da vaga com a candidatura devolvida por uma ação (a vaga passa a ter candidatura). */
export function withApplication(data: JobApplicationDto | null | undefined, application: ApplicationDto): JobApplicationDto {
  return { application, site: data?.site ?? application.site, canApply: false, cannotApplyReason: 'already_exists' };
}

/**
 * "Já apliquei por conta própria": um card antes de Aplicada vai para Aplicada; um card que já está em Aplicada ou depois
 * manda a própria coluna de novo (`sameColumn`), para a API encerrar a candidatura mesmo sem o card mudar de lugar.
 */
export function markAppliedTarget(column: Column): { column: Column; sameColumn: boolean } {
  return isAppliedOrLater(column) ? { column, sameColumn: true } : { column: 'aplicada', sameColumn: false };
}

/** O passo pedido agora, no painel da vaga que tem a espera ao vivo; null nas demais. */
export function liveWaitFor(status: ApplyStatusDto | undefined, jobId: number): string | null {
  const waiting = status?.waiting;
  return waiting && waiting.jobId === jobId ? `${waitingText(waiting.gate)}.` : null;
}

/** O que a linha aberta da aba diz quando a candidatura não espera mais respostas. */
export function rowAnswersText(application: ApplicationDto | null): string {
  if (application && (application.status === 'queued' || RUNNING_STATUSES.includes(application.status))) {
    return 'Respostas recebidas. A candidatura voltou para a fila e continua sozinha.';
  }
  return 'Esta candidatura não espera mais respostas. Veja o estado dela no painel da vaga.';
}

const WAITING_TEXT: Record<string, string> = {
  captcha: 'Resolva o captcha na janela do navegador das candidaturas',
  verification_code: 'Digite o código de verificação na janela do navegador das candidaturas',
  login: 'Entre na sua conta na janela do navegador das candidaturas',
};

/** O que o dono precisa fazer agora numa espera ao vivo (`ApplyStatusDto.waiting.gate`). */
export function waitingText(gate: string): string {
  return WAITING_TEXT[gate] ?? 'Conclua o passo pedido na janela do navegador das candidaturas';
}

export const SCOPE_LABELS: Record<AnswerScope, string> = { always: 'sempre', company: 'só nesta empresa', job: 'só nesta vaga' };

export const SHOT_LABELS: Record<ShotKind, string> = {
  filled: 'Formulário preenchido', confirmation: 'Confirmação do site', blocked: 'Onde parou',
};

/** Dica de uma proposta da IA: o texto escrito vale só para a vaga; o fato do perfil fica salvo para as próximas. */
export const PROPOSAL_HINTS = {
  written: 'Você pode editar o texto antes de aprovar. A resposta aprovada fica salva só para esta vaga.',
  profile: 'A resposta aprovada fica salva e será usada nas próximas candidaturas.',
} as const;

/** Um valor de resposta para ler na tela: Sim/Não, opções separadas por vírgula, travessão quando vazio. */
export function answerText(value: AnswerValue): string {
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  return value === null || value.trim() === '' ? '—' : value;
}

/** O valor em branco no tipo da pergunta: lista para múltipla escolha, null para sim/não, texto vazio no resto. */
export function emptyAnswerValue(question: Question): AnswerValue {
  if (question.kind === 'multiselect') return [];
  if (question.kind === 'boolean' && question.options.length === 0) return null;
  return '';
}

/** O alcance com que a API grava uma proposta aprovada: o texto escrito vale só para a vaga. */
const proposalScope = (p: PendingQuestion): AnswerScope => (p.proposal?.source === 'written' ? 'job' : 'always');

/** Como a pendência começa no formulário: sem resposta, em branco; com proposta, aceita. */
export function initialPendingDraft(p: PendingQuestion): PendingDraft {
  const id = p.question.id;
  if (p.kind === 'unanswered' || !p.proposal) return { questionId: id, accept: false, value: emptyAnswerValue(p.question), scope: 'always' };
  return { questionId: id, accept: true, value: p.proposal.value, scope: proposalScope(p) };
}

const sameAnswerValue = (a: AnswerValue, b: AnswerValue): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return a === b;
};

/** O dono mudou o valor: numa proposta da IA, o valor igual ao proposto continua sendo o aceite; diferente, vira a resposta dele. */
export function editPendingDraft(p: PendingQuestion, draft: PendingDraft, value: AnswerValue): PendingDraft {
  if (p.kind === 'confirm_proposal' && p.proposal) {
    return sameAnswerValue(value, p.proposal.value) ? initialPendingDraft(p) : { ...draft, accept: false, value, scope: proposalScope(p) };
  }
  return { ...draft, accept: false, value };
}

/** A recusa da API ("Rótulo: motivo") ao lado da pergunta que ela nomeia; null quando não nomeia nenhuma. */
export function pendingErrorFor(pending: PendingQuestion[], message: string): { questionId: string; text: string } | null {
  const lower = message.toLowerCase();
  const hit = pending.find((p) => lower.startsWith(`${p.question.label.toLowerCase()}: `));
  if (!hit) return null;
  const rest = message.slice(hit.question.label.length + 2).trim();
  return { questionId: hit.question.id, text: rest.charAt(0).toUpperCase() + rest.slice(1) };
}
/** Limites do banco de respostas (os mesmos de `ApplyAnswerInputSchema`). */
export const ANSWER_LIMITS = { question: 500, answer: 2000, company: 200 } as const;

/** O contador de caracteres só aparece perto do limite (a partir de 90%). */
export const counterVisible = (length: number, max: number): boolean => length >= Math.floor(max * 0.9);

/** As perguntas comuns (têm `key`) e as aprendidas (sem `key`), cada grupo na ordem em que a API devolveu. */
export function splitAnswers(rows: ApplyAnswerDto[]): { common: ApplyAnswerDto[]; learned: ApplyAnswerDto[] } {
  return { common: rows.filter((r) => r.key !== null), learned: rows.filter((r) => r.key === null) };
}

/** Qual campo edita a resposta: sim/não/sem resposta, número, ou texto (que cresce; `choice` é uma opção por linha). */
export type AnswerField = 'boolean' | 'number' | 'text';
export const answerField = (kind: ApplyAnswerDto['kind']): AnswerField =>
  kind === 'boolean' ? 'boolean' : kind === 'number' ? 'number' : 'text';

export type BooleanChoice = 'yes' | 'no' | 'none';
export const BOOLEAN_LABELS: Record<BooleanChoice, string> = { yes: 'Sim', no: 'Não', none: 'Sem resposta' };

/** O texto salvo lido como sim, não ou sem resposta (texto que não é sim nem não também é "sem resposta"). */
export function booleanChoice(answer: string): BooleanChoice {
  const value = bankBoolean(answer);
  return value === true ? 'yes' : value === false ? 'no' : 'none';
}

/** O texto que se salva para a escolha: `Sim`, `Não` ou vazio. */
export const booleanAnswer = (choice: BooleanChoice): string => (choice === 'none' ? '' : bankText(choice === 'yes'));

/** Problema do número digitado, em pt-BR; null quando está vazio ou serve. A regra é a única, de `@kv/shared` (a da API). */
export function numberProblem(text: string): string | null {
  if (text.trim() === '') return null;
  return parseNumberAnswer(text) === null ? NUMBER_FORMAT_PROBLEM : null;
}

/** O que é gravado a partir do que foi digitado: texto aparado, uma opção por linha, número com ponto decimal. */
export function answerToStore(kind: ApplyAnswerDto['kind'], draft: string): string {
  if (kind === 'number') return parseNumberAnswer(draft) ?? draft.trim();
  if (kind === 'choice') return bankText(bankList(draft));
  return draft.trim();
}

/** Problema que impede salvar a resposta digitada; null quando pode. */
export const answerProblem = (kind: ApplyAnswerDto['kind'], draft: string): string | null =>
  kind === 'number' ? numberProblem(draft) : null;

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** O estado ao lado do campo, como nas notas da vaga; `dirty` é texto mudado depois do último salvamento. */
export function saveStateLabel(status: SaveStatus, dirty: boolean): string {
  if (status === 'saving') return 'Salvando…';
  if (status === 'error') return 'Não salvo';
  return status === 'saved' && !dirty ? 'Salvo' : '';
}

/** O alcance da resposta em palavras. */
export function scopeLabel(scope: AnswerScope, scopeValue: string | null): string {
  if (scope === 'always') return 'sempre';
  if (scope === 'job') return 'só nesta vaga';
  return `só na empresa ${scopeValue?.trim() || '(sem nome)'}`;
}

/** O país a que a resposta se limita; null quando vale em qualquer um. */
export function countryLabel(country: string | null): string | null {
  if (!country) return null;
  if (country === 'BR') return 'vagas no Brasil';
  // Resposta pessoal aprendida numa vaga de fora do Brasil (o país da vaga é BR ou INT).
  if (country === 'INT') return 'vagas fora do Brasil';
  return `vagas em ${country}`;
}

export function usedLabel(count: number): string {
  return count === 0 ? 'ainda não usada' : count === 1 ? 'usada 1 vez' : `usada ${count} vezes`;
}

/** O corpo de PUT /apply/answers/:id: a mesma resposta, com o novo texto. */
export function answerInput(row: ApplyAnswerDto, answer: string): ApplyAnswerInput {
  return { question: row.question, answer, kind: row.kind, scope: row.scope, scopeValue: row.scopeValue, country: row.country };
}

export type NewAnswerKind = ApplyAnswerDto['kind'];
export const NEW_ANSWER_KIND_LABELS: Record<NewAnswerKind, string> = { text: 'Texto', number: 'Número', boolean: 'Sim ou não', choice: 'Escolha' };

/** O formulário "Adicionar resposta". "Só nesta vaga" não existe aqui: só faz sentido dentro de uma candidatura. */
export interface NewAnswerDraft {
  question: string; answer: string; kind: NewAnswerKind; scope: 'always' | 'company'; company: string; brazilOnly: boolean;
}
export const EMPTY_NEW_ANSWER: NewAnswerDraft = { question: '', answer: '', kind: 'text', scope: 'always', company: '', brazilOnly: false };

export type NewAnswerErrors = Partial<Record<'question' | 'answer' | 'company', string>>;

export function validateNewAnswer(draft: NewAnswerDraft): NewAnswerErrors {
  const errors: NewAnswerErrors = {};
  if (draft.question.trim() === '') errors.question = 'Escreva a pergunta.';
  const problem = answerProblem(draft.kind, draft.answer);
  if (problem) errors.answer = problem;
  else if (draft.answer.trim() === '') errors.answer = 'Escreva a resposta.';
  if (draft.scope === 'company' && draft.company.trim() === '') errors.company = 'Escreva o nome da empresa.';
  return errors;
}

/** O campo que recebe o foco depois de um envio barrado: o primeiro com erro, na ordem do formulário. */
export function firstNewAnswerError(errors: NewAnswerErrors): 'question' | 'company' | 'answer' | null {
  return (['question', 'company', 'answer'] as const).find((k) => errors[k]) ?? null;
}

export function newAnswerInput(draft: NewAnswerDraft): ApplyAnswerInput {
  return {
    question: draft.question.trim(), answer: answerToStore(draft.kind, draft.answer), kind: draft.kind, scope: draft.scope,
    scopeValue: draft.scope === 'company' ? draft.company.trim() : null, country: draft.brazilOnly ? 'BR' : null,
  };
}

/** A dica curta sob a pergunta, conforme o tipo de resposta; '' quando não há o que dizer. */
export function kindHint(kind: ApplyAnswerDto['kind']): string {
  if (kind === 'number') return 'Número, sem separador de milhar (por exemplo 8000).';
  if (kind === 'choice') return 'Uma opção por linha.';
  return '';
}

/** O que fazer ao sair do campo de uma resposta guardada: `draft` é o que foi digitado (`null` = nada foi digitado). */
export type CommitDecision =
  | { action: 'nothing' } | { action: 'unchanged' } | { action: 'invalid'; problem: string } | { action: 'send'; stored: string };

export function decideCommit(kind: ApplyAnswerDto['kind'], draft: string | null, saved: string): CommitDecision {
  // Nada digitado, nada enviado: o texto guardado pode não estar na forma canônica, e sair do campo não o muda.
  if (draft === null) return { action: 'nothing' };
  const problem = answerProblem(kind, draft);
  if (problem) return { action: 'invalid', problem };
  const stored = answerToStore(kind, draft);
  return stored === saved ? { action: 'unchanged' } : { action: 'send', stored };
}

/** Uma fila por chave: a próxima tarefa da chave espera a anterior terminar (com sucesso ou erro); chaves diferentes não esperam. */
export function createKeyedQueue<K>() {
  const tails = new Map<K, Promise<unknown>>();
  return function run<T>(key: K, task: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

/**
 * Uma notificação por espera ao vivo NOVA: a primeira observação (`seen` indefinido) só registra a chave, para uma
 * espera que já existia ao abrir a página não avisar de novo. `seen` e `key` são `applicationId:gate` ou null.
 */
export function waitNotice(seen: string | null | undefined, key: string | null): { notify: boolean; seen: string | null } {
  return { notify: seen !== undefined && key !== null && key !== seen, seen: key };
}

/** A candidatura logo depois de "Enviar de verdade" dar certo: na fila, para valer até a releitura chegar. */
export function afterSend(application: ApplicationDto): ApplicationDto {
  return { ...application, status: 'queued', mode: 'real', reason: null, detail: null };
}
