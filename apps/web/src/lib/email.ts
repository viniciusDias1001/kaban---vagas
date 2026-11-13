import {
  COLUMN_LABELS, KNOWN_FACT_LABELS, type AlertDto, type AlertKind, type EmailKind, type JobMailMarks, type ReplyState,
} from '@kv/shared/client';
import { DRAFT_PLACEHOLDER, EMAIL_KIND_LABELS, type JobEmailsDto, type MailMessageDto, type MailReplyDto } from '@kv/shared/client';

/** Funções puras do e-mail (sem React): textos dos alertas, rótulos e a conferência da senha de app. */

const subjectOf = (a: AlertDto): string => a.subject?.trim() ?? '';
/** O assunto para um título: nunca vazio (o título não termina em dois-pontos soltos). */
const titleSubject = (a: AlertDto): string => subjectOf(a) || '(sem assunto)';
/** A empresa do card; sem ela, o assunto do e-mail. */
const who = (a: AlertDto): string => a.company?.trim() || titleSubject(a);

export function alertTitle(a: AlertDto): string {
  switch (a.kind) {
    case 'interview': return `Convite de entrevista: ${who(a)}`;
    case 'offer': return `Oferta: ${who(a)}`;
    case 'missing_fact': return `${who(a)} pediu algo que você não salvou`;
    // Sem resposta preparada (e-mail que não aceita resposta, IA desligada ou falhou), o título não promete um rascunho.
    case 'draft': return a.replyId === null ? `${who(a)} pediu uma resposta sua` : `Rascunho esperando você: ${who(a)}`;
    case 'move_confirm': return `Mover ${who(a)} para ${a.payload.moveTo ? COLUMN_LABELS[a.payload.moveTo] : 'outra coluna'}?`;
    case 'unmatched': return `E-mail sem vaga: ${titleSubject(a)}`;
    case 'mailbox_error': return 'A caixa de e-mail parou';
    case 'backfill_summary': return 'Primeira leitura da caixa';
    case 'budget_waiting':
      return `${a.payload.waiting ?? 0} e-mails de vaga esperando classificação (limite diário de IA atingido)`;
  }
}

/** Os tipos em que o worker pode dizer, em `payload.reason`, por que não há resposta pronta. */
const REASON_KINDS: ReadonlySet<AlertKind> = new Set(['draft', 'interview', 'missing_fact']);

/**
 * O texto de apoio do alerta: o resumo do e-mail, ou o assunto; alguns tipos têm texto próprio. Num pedido, convite ou dado
 * que falta, o motivo de não haver resposta pronta vem numa segunda linha.
 */
export function alertBody(a: AlertDto): string {
  const main = alertMainBody(a);
  const reason = REASON_KINDS.has(a.kind) ? a.payload.reason?.trim() ?? '' : '';
  return [main, reason].filter((line) => line !== '').join('\n');
}

function alertMainBody(a: AlertDto): string {
  switch (a.kind) {
    case 'missing_fact': {
      // Um dado que esta versão da tela não conhece aparece pela própria chave, nunca como "undefined".
      const labels = (a.payload.missing ?? []).map((f) => KNOWN_FACT_LABELS[f] ?? f);
      return `Falta: ${labels.join(', ')}`;
    }
    case 'backfill_summary': return summaryLine(a.payload.counts ?? {}, a.payload.total ?? 0);
    case 'mailbox_error': return a.payload.reason?.trim() || 'Abra Configurações > E-mail para reconectar.';
    default: return a.summary?.trim() || subjectOf(a);
  }
}

export type AlertAction =
  | 'open_job' | 'review_draft' | 'confirm_move' | 'link' | 'answer_fact' | 'open_settings' | 'open_list' | 'classify_anyway';

const ALERT_ACTIONS: Record<AlertKind, AlertAction> = {
  interview: 'review_draft',
  draft: 'review_draft',
  offer: 'open_job',
  move_confirm: 'confirm_move',
  unmatched: 'link',
  missing_fact: 'answer_fact',
  mailbox_error: 'open_settings',
  backfill_summary: 'open_list',
  budget_waiting: 'classify_anyway',
};

/** O que o botão principal do alerta faz. */
export const alertAction = (kind: AlertKind): AlertAction => ALERT_ACTIONS[kind];

/** O alerta é sobre um e-mail que não tem card (sem vaga, ou convite e oferta que o worker não ligou): dá para ligá-lo a uma vaga. */
export const alertCanLink = (a: AlertDto): boolean => a.messageId !== null && a.jobId === null;

/** Alertas `interview` e `offer` que ainda não viraram aviso do navegador, pela chave `alert-<id>`. */
export function alertsToNotify(alerts: AlertDto[], seen: ReadonlySet<string>): AlertDto[] {
  return alerts.filter((a) => (a.kind === 'interview' || a.kind === 'offer') && !seen.has(`alert-${a.id}`));
}

const REPLY_STATE_LABELS: Record<ReplyState, string> = {
  rascunho: 'Rascunho',
  aprovada: 'Aprovada, na fila de envio',
  enviando: 'Enviando',
  enviada: 'Enviada',
  falhou: 'O envio falhou',
  descartada: 'Descartada',
};

export const replyStateLabel = (state: ReplyState): string => REPLY_STATE_LABELS[state];

const BADGE_LABELS: Record<NonNullable<JobMailMarks['badge']>, string> = {
  entrevista: 'entrevista', oferta: 'oferta', pedido: 'pediu informação',
};

export const mailBadgeLabel = (badge: NonNullable<JobMailMarks['badge']>): string => BADGE_LABELS[badge];

/** Os tipos listados na frase da primeira leitura, na ordem em que aparecem, com singular e plural. */
const SUMMARY_PARTS: { kind: EmailKind; one: string; many: string }[] = [
  { kind: 'reprovacao', one: 'reprovação', many: 'reprovações' },
  { kind: 'entrevista', one: 'convite', many: 'convites' },
  { kind: 'oferta', one: 'oferta', many: 'ofertas' },
  { kind: 'pedido', one: 'pedido', many: 'pedidos' },
];

/** "Li 14 e-mails de vagas: 5 reprovações, 2 convites, 1 oferta." Sem nada a listar, a frase termina no total. */
export function summaryLine(counts: Partial<Record<EmailKind, number>>, total: number): string {
  const head = `Li ${total} ${total === 1 ? 'e-mail de vaga' : 'e-mails de vagas'}`;
  const parts = SUMMARY_PARTS.flatMap(({ kind, one, many }) => {
    const n = counts[kind] ?? 0;
    return n > 0 ? [`${n} ${n === 1 ? one : many}`] : [];
  });
  return parts.length === 0 ? `${head}.` : `${head}: ${parts.join(', ')}.`;
}

/**
 * Confere a senha de app antes de enviar; devolve a mensagem de erro ou null. O mesmo critério de `MailAccountInputSchema`
 * (que é Zod e não entra no navegador): o Google mostra a senha em grupos, então todo espaço em branco sai antes; sobram
 * de 8 a 64 caracteres ASCII visíveis.
 */
export function mailPasswordProblem(raw: string): string | null {
  const password = raw.replace(/\s+/g, '');
  if (password === '') return 'Cole a senha de app.';
  if (password.length < 8) return 'A senha de app parece curta demais.';
  if (password.length > 64) return 'A senha de app é longa demais.';
  if (!/^[\x21-\x7e]+$/.test(password)) return 'A senha de app só pode ter letras, números e símbolos comuns.';
  return null;
}

/** O que o app fez com o e-mail, em pt-BR; lista vazia quando não fez nada. */
export function mailActions(m: MailMessageDto): string[] {
  const out: string[] = [];
  if (m.movedTo) out.push(`moveu o card para ${COLUMN_LABELS[m.movedTo]}`);
  if (m.replyState === 'enviada') out.push(m.replyApprovedBy === 'owner' ? 'respondeu com o seu OK' : 'respondeu sozinho');
  else if (m.replyState === 'rascunho') out.push('rascunho esperando você');
  else if (m.replyState === 'descartada') out.push('resposta descartada');
  else if (m.replyState === 'falhou') out.push('envio falhou');
  else if (m.alerted && m.replyState === null) out.push('alertou você');
  if (m.corrected) out.push('classificação corrigida');
  return out;
}

/** Um item da conversa da vaga: o e-mail e, conforme o caso, a resposta mostrada sob ele ou a resposta que ele é. */
export interface ConversationItem {
  message: MailMessageDto;
  /** A resposta preparada para este e-mail recebido, mostrada logo abaixo dele (null quando já aparece como cópia enviada). */
  reply: MailReplyDto | null;
  /** Este e-mail de saída é a cópia guardada desta resposta enviada pelo app. */
  sentReply: MailReplyDto | null;
  /** O e-mail recebido a que `sentReply` responde (dele vem quem aprovou o envio). */
  origin: MailMessageDto | null;
}

/**
 * A conversa em ordem, cada coisa uma vez só. Ao enviar, o worker guarda a resposta também como e-mail de saída com o
 * Message-ID dela: a cópia é ligada à resposta só por `outMessageId === messageId`, nunca pelo texto. A resposta com cópia
 * aparece no lugar da cópia; sem cópia guardada (ainda), sob o e-mail recebido.
 */
export function emailConversation({ messages, replies }: JobEmailsDto): ConversationItem[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const byOutId = new Map(replies.flatMap((r) => (r.outMessageId ? [[r.outMessageId, r] as const] : [])));
  const copies = new Map<number, MailReplyDto>();
  for (const m of messages) {
    const r = m.direction === 'out' ? byOutId.get(m.messageId) : undefined;
    if (r) copies.set(m.id, r);
  }
  const shownAsCopy = new Set([...copies.values()].map((r) => r.id));
  const below = new Map(replies.filter((r) => !shownAsCopy.has(r.id)).map((r) => [r.messageId, r]));
  return messages.map((m) => {
    const sentReply = copies.get(m.id) ?? null;
    return {
      message: m,
      reply: m.direction === 'in' ? (below.get(m.id) ?? null) : null,
      sentReply,
      origin: sentReply ? (byId.get(sentReply.messageId) ?? null) : null,
    };
  });
}

/**
 * Só o fio `threadKey` da conversa da vaga, do mais antigo ao mais novo, com as mesmas regras de `emailConversation`: uma
 * resposta enviada aparece no lugar da cópia guardada, ou sob o e-mail recebido enquanto a cópia não chega.
 */
export function threadConversation(dto: JobEmailsDto, threadKey: string): ConversationItem[] {
  const messages = [...dto.messages].sort((a, b) => a.sentAt - b.sentAt || a.id - b.id);
  return emailConversation({ messages, replies: dto.replies }).filter((i) => i.message.threadKey === threadKey);
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A resposta vai para outro endereço que não o de quem escreveu (um Reply-To, por exemplo): o sino e o painel da vaga
 * avisam. `origin` é o e-mail recebido, ou a conversa carregada, onde ele é achado pelo id; sem ele, não há aviso.
 */
export function replyGoesElsewhere(reply: MailReplyDto, origin: MailMessageDto | readonly MailMessageDto[] | undefined): boolean {
  const from = Array.isArray(origin)
    ? (origin as readonly MailMessageDto[]).find((m) => m.id === reply.messageId)
    : (origin as MailMessageDto | undefined);
  return from !== undefined && !sameAddress(reply.toAddress, from.fromAddress);
}

/** Quantos e-mails a lista do Painel recebe no máximo: o mesmo `MAIL_LIST_MAX` de `packages/db/src/mail.ts`. */
export const MAIL_LIST_MAX = 500;

/** O aviso de lista cortada: só quando veio exatamente o máximo (pode haver mais, mais antigos). */
export const mailListNotice = (count: number): string | null =>
  count >= MAIL_LIST_MAX ? `Mostrando os ${MAIL_LIST_MAX} mais recentes.` : null;

/**
 * O e-mail aberto na conversa do Painel, lido das linhas atuais (que são relidas depois de cada ação); se ele saiu da
 * lista (o filtro "Sem vaga" depois de ligá-lo a uma vaga, por exemplo), fica o último visto.
 */
export function selectedMail(rows: readonly MailMessageDto[], id: number | null, last: MailMessageDto | null): MailMessageDto | null {
  if (id === null) return null;
  return rows.find((m) => m.id === id) ?? (last?.id === id ? last : null);
}

/** O e-mail que moveu o card, numa linha do histórico: "E-mail — Reprovação: Sua candidatura na Acme". */
export function historyMailLine(mail: { kind: EmailKind | null; subject: string }): string {
  const subject = mail.subject.trim() || '(sem assunto)';
  return mail.kind ? `E-mail — ${EMAIL_KIND_LABELS[mail.kind]}: ${subject}` : `E-mail — ${subject}`;
}

/** O que a caixa de um rascunho permite agora: o texto da caixa é julgado contra o texto guardado no servidor. */
export interface DraftGate {
  /** Ainda há um trecho `[[...]]` para preencher. */
  gap: boolean;
  /** O texto da caixa não é o guardado: falta "Salvar edição". */
  unsaved: boolean;
  empty: boolean;
  /** Só quando a caixa mostra exatamente o texto guardado, sem lacuna: o que se vê é o que sai. */
  canApprove: boolean;
  /** Por que "Aprovar e enviar" está desligado, ou null. */
  hint: string | null;
}

export function draftGate(stored: string, text: string): DraftGate {
  const gap = DRAFT_PLACEHOLDER.test(text);
  const unsaved = text !== stored;
  const empty = text.trim() === '';
  const hint = empty
    ? 'Escreva o texto da resposta.'
    : gap ? 'Preencha os trechos entre colchetes duplos.' : unsaved ? 'Salve a edição antes de enviar.' : null;
  return { gap, unsaved, empty, canApprove: !gap && !unsaved && !empty, hint };
}
