import type {
  AnswerScope, AnswerValue, ApplicationDto, ApplicationListItemDto, ApplyAnswerDto, ApplySiteId, ApplyStatusDto,
} from '@kv/shared/client';
import { ApiError, NETWORK_ERROR } from './apiError';
import { applyErrorMessage } from './lib/apply';

/** Corpo de POST e PUT /apply/answers (o mesmo de `ApplyAnswerInputSchema`). */
export interface ApplyAnswerInput {
  question: string; answer: string; kind: ApplyAnswerDto['kind']; scope: AnswerScope; scopeValue: string | null; country: string | null;
}

/** Corpo de PUT /applications/:id/answers (o mesmo de `PendingAnswersBodySchema`). */
export interface PendingAnswersBody {
  answers: { questionId: string; value: AnswerValue; scope: AnswerScope; confirmMatch: boolean }[];
}

/** Chamadas das rotas de candidatura automática. Mesmo tratamento de erro do `aiApi`, com os códigos 409 em pt-BR. */
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
    throw new ApiError(res.status, applyErrorMessage(res.status, text));
  }
  // Um sucesso sem corpo (204, ou 202 sem corpo) não tem valor; só um corpo que não é JSON é resposta inesperada.
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
const del = (): RequestInit => ({ method: 'DELETE' });

export const applyApi = {
  status: () => request<ApplyStatusDto>('/apply/status'),
  applications: () => request<ApplicationListItemDto[]>('/applications'),
  /** null quando a vaga não tem candidatura (404). */
  jobApplication: async (jobId: number): Promise<ApplicationDto | null> => {
    try {
      return await request<ApplicationDto>(`/jobs/${jobId}/application`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  apply: (jobId: number) => request<{ id: number }>(`/jobs/${jobId}/application`, post()),
  retry: (id: number) => request<void>(`/applications/${id}/retry`, post()),
  cancel: (id: number) => request<void>(`/applications/${id}/cancel`, post()),
  send: (id: number) => request<void>(`/applications/${id}/send`, post()),
  sendAll: () => request<{ queued: number }>('/applications/send-rehearsals', post()),
  /** A candidatura devolvida é a verdade: pode continuar em `needs_human` se faltou uma pendência obrigatória. */
  answer: (id: number, body: PendingAnswersBody) => request<ApplicationDto>(`/applications/${id}/answers`, json('PUT', body)),

  openLogin: (site: ApplySiteId) => request<{ queued: true }>(`/apply/sessions/${site}/open`, post()),
  checkSession: (site: ApplySiteId) => request<{ queued: true }>(`/apply/sessions/${site}/check`, post()),
  logout: (site: ApplySiteId) => request<{ queued: true }>(`/apply/sessions/${site}`, del()),
  resumeSite: (site: ApplySiteId) => request<void>(`/apply/sites/${site}/resume`, post()),

  answers: () => request<ApplyAnswerDto[]>('/apply/answers'),
  createAnswer: (input: ApplyAnswerInput) => request<ApplyAnswerDto>('/apply/answers', json('POST', input)),
  updateAnswer: (id: number, input: ApplyAnswerInput) => request<ApplyAnswerDto>(`/apply/answers/${id}`, json('PUT', input)),
  deleteAnswer: (id: number) => request<void>(`/apply/answers/${id}`, del()),
  removeAlias: (id: number, normalized: string) =>
    request<void>(`/apply/answers/${id}/aliases/${encodeURIComponent(normalized)}`, del()),
};

/** Links da mesma origem, abertos pelo navegador (não passam pelo `fetch`). */
export const applicationResumeUrl = (id: number) => `/api/applications/${id}/resume.pdf`;
export const applicationShotUrl = (id: number, kind: string) => `/api/applications/${id}/shots/${kind}`;
