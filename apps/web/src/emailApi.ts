import type {
  AlertDto, EmailKind, JobEmailsDto, MailAccountDto, MailIgnoredDto, MailMessageDto, MailReplyDto,
} from '@kv/shared/client';
import { ApiError, NETWORK_ERROR, errorMessage } from './apiError';

/** Corpo de PUT /email/account. A senha nunca volta em nenhuma resposta. */
export interface MailAccountInput { address: string; password: string }

/** Filtro de GET /email/messages. */
export interface MailMessageFilter { kind?: EmailKind; unmatched?: boolean; since?: number }

/** Códigos de erro cuja mensagem em pt-BR a API já escreve para o dono: ela é mostrada como veio. */
const MESSAGE_CODES = new Set([
  'email_unavailable', 'no_app_secret', 'mail_auth', 'mail_unreachable', 'rate_limited', 'draft_has_gaps', 'not_a_draft',
  'wrong_state', 'wrong_kind', 'alert_closed', 'cannot_undo',
]);

/** O texto de um erro das rotas de e-mail: a mensagem da API nos códigos conhecidos (qualquer status), o padrão nos demais. */
export function emailErrorMessage(status: number, bodyText: string): string {
  try {
    const body = JSON.parse(bodyText) as { error?: unknown; message?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (typeof body?.error === 'string' && MESSAGE_CODES.has(body.error) && message !== '') {
      return message.charAt(0).toUpperCase() + message.slice(1);
    }
  } catch {
    /* corpo que não é JSON */
  }
  return errorMessage(status, bodyText);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    const isJson = typeof init?.body === 'string';
    res = await fetch(`/api${path}`, { ...init, headers: isJson ? { 'content-type': 'application/json' } : undefined });
  } catch {
    throw new ApiError(0, NETWORK_ERROR);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, emailErrorMessage(res.status, text));
  }
  // Um sucesso sem corpo (204) não tem valor.
  const text = await res.text().catch(() => '');
  if (text.trim() === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'A API respondeu algo inesperado. Confira se ela está no ar e tente de novo.');
  }
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const post = (): RequestInit => ({ method: 'POST' });

export const getMailAccount = () => request<MailAccountDto>('/email/account');
export const connectMailbox = (input: MailAccountInput) => request<MailAccountDto>('/email/account', json('PUT', input));
/** Sempre manda `messages` de forma explícita: `keep` guarda os e-mails já lidos, `delete` os apaga. */
export const disconnectMailbox = (messages: 'keep' | 'delete') =>
  request<void>(`/email/account?messages=${messages}`, { method: 'DELETE' });

export function listMailMessages(filter: MailMessageFilter = {}) {
  const query = new URLSearchParams();
  if (filter.kind) query.set('kind', filter.kind);
  if (filter.unmatched) query.set('unmatched', '1');
  if (filter.since !== undefined) query.set('since', String(filter.since));
  const qs = query.toString();
  return request<MailMessageDto[]>(`/email/messages${qs ? `?${qs}` : ''}`);
}
export const getJobEmails = (jobId: number) => request<JobEmailsDto>(`/jobs/${jobId}/emails`);
export const linkMessage = (id: number, jobId: number) => request<{ ok: true }>(`/email/messages/${id}/link`, json('POST', { jobId }));
export const unlinkMessage = (id: number) => request<{ ok: true }>(`/email/messages/${id}/unlink`, post());
export const undoMailMove = (id: number) => request<{ ok: true }>(`/email/messages/${id}/undo-move`, post());
export const listIgnored = () => request<MailIgnoredDto[]>('/email/ignored');
export const promoteIgnored = (id: number) => request<{ ok: true }>(`/email/ignored/${id}/promote`, post());

export const editReply = (id: number, body: string) => request<MailReplyDto>(`/email/replies/${id}`, json('PATCH', { body }));
export const approveReply = (id: number) => request<MailReplyDto>(`/email/replies/${id}/approve`, post());
export const discardReply = (id: number) => request<MailReplyDto>(`/email/replies/${id}/discard`, post());

export const listAlerts = () => request<{ alerts: AlertDto[] }>('/alerts');
export const dismissAlert = (id: number) => request<{ ok: true }>(`/alerts/${id}/dismiss`, post());
export const answerMoveAlert = (id: number, accept: boolean) => request<{ moved: boolean }>(`/alerts/${id}/move`, json('POST', { accept }));
export const retryAlert = (id: number) => request<{ ok: true }>(`/alerts/${id}/retry`, post());
export const classifyAnyway = (id: number) => request<{ released: number }>(`/alerts/${id}/classify-anyway`, post());
