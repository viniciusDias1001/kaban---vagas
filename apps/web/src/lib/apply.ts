import {
  ACTIVE_APPLICATION_STATUSES,
  type AnswerScope, type AnswerSource, type AnswerValue, type ApplicationListItemDto, type ApplicationReason, type ApplicationStatus,
  type ApplicationDto, type ApplyAiAnswers, type ApplyAnswerDto, type ApplyStatusDto, type PendingQuestion, type Question,
  type ShotKind, bankBoolean, bankList, bankText,
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

export const ANSWER_SOURCE_LABELS: Record<AnswerSource, string> = {
  rule: 'regra', bank: 'sua resposta', profile: 'do perfil', written: 'escrita pela IA', blank: 'em branco',
};

/** Intervalo de releitura: 2 s com candidatura na fila, em andamento ou com espera ao vivo; 15 s caso contrário. */
export function applyPollMs(status: ApplyStatusDto | undefined): number {
  return status && (status.queued > 0 || status.running > 0 || status.waiting !== null) ? 2_000 : 15_000;
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
  not_cancellable: 'Esta candidatura já terminou.',
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
}

export function applicationActions(app: { status: ApplicationStatus; reason: ApplicationReason | null }): ApplicationActions {
  const unconfirmed = app.status === 'needs_human' && app.reason === 'confirm_submission';
  const running = RUNNING.includes(app.status);
  return {
    send: app.status === 'dry_run_ready',
    retry: (app.status === 'needs_human' && !unconfirmed) || app.status === 'failed' || app.status === 'skipped' || app.status === 'cancelled',
    cancel: app.status === 'queued' || running || app.status === 'needs_human' || app.status === 'dry_run_ready',
    cancelLater: running,
    alreadyApplied: unconfirmed,
  };
}

/** "Aplicar com IA": a vaga não tem candidatura (`null`; `undefined` = ainda carregando) e a função está disponível e ligada. */
export function canApplyNow(status: ApplyStatusDto | undefined, application: unknown | null | undefined): boolean {
  return application === null && status?.available === true && status.enabled;
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

/** Recusa de um número com três casas depois do separador (a API faz o mesmo): vale para milhar e para decimais longos. */
export const NUMBER_FORMAT_PROBLEM = 'Use só dígitos, com no máximo duas casas decimais e sem separador de milhar (ex.: 20000 ou 1234,56).';

/** Problema do número digitado, em pt-BR; null quando está vazio ou serve. Mesma regra da API: sem separador de milhar. */
export function numberProblem(text: string): string | null {
  const value = text.trim();
  if (value === '') return null;
  if (/\d[.,]\d{3}(\D|$)/.test(value)) return NUMBER_FORMAT_PROBLEM;
  if (!/^\d+([.,]\d+)?$/.test(value)) return 'Use só números, com vírgula ou ponto para os decimais (por exemplo 8000 ou 8000,50).';
  return null;
}

/** O que é gravado a partir do que foi digitado: texto aparado, uma opção por linha, número com ponto decimal. */
export function answerToStore(kind: ApplyAnswerDto['kind'], draft: string): string {
  if (kind === 'number') return draft.trim().replace(',', '.');
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
  return country === 'BR' ? 'vagas no Brasil' : `vagas em ${country}`;
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
