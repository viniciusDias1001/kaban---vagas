import type {
  AiStatusDto, AiUsageDto, CandidateProfileDto, JobAiDetailDto, JobAiSummaryDto, ProfileOverviewDto, ProfileWire,
  AiKeyMetaDto, AiProviderId, ResumeLang, ResumeMetaDto, SettingsDto, SettingsPatch, TailoredDraft, TailoredSaveDto,
  TailoredStateDto, TestConnectionDto,
} from '@kv/shared/client';
import { ApiError, NETWORK_ERROR, errorMessage } from './apiError';

/**
 * Chamadas das rotas de IA. Mesmo tratamento de erro do cliente do Core (`ApiError` + `errorMessage`).
 * O corpo vai como JSON, exceto no upload: um `FormData` segue sem `content-type` manual, para o
 * navegador escrever o `boundary` do multipart.
 */
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
    throw new ApiError(res.status, errorMessage(res.status, text));
  }
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(res.status, 'A API respondeu algo inesperado. Confira se ela está no ar e tente de novo.');
  }
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const post = (): RequestInit => ({ method: 'POST' });

export const aiApi = {
  status: () => request<AiStatusDto>('/ai/status'),
  usage: () => request<AiUsageDto>('/ai/usage'),
  profile: () => request<ProfileOverviewDto>('/ai/profile'),
  uploadResume: (lang: ResumeLang, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<ResumeMetaDto>(`/ai/resumes/${lang}`, { method: 'POST', body: form });
  },
  saveProfile: (lang: ResumeLang, data: ProfileWire) => request<CandidateProfileDto>(`/ai/profile/${lang}`, json('PUT', { data })),
  translateProfile: (lang: ResumeLang) => request<{ queued: boolean }>(`/ai/profile/${lang}/translate`, post()),
  confirmTask: (taskId: number) => request<{ queued: boolean }>(`/ai/tasks/${taskId}/confirm`, post()),
  jobScores: () => request<JobAiSummaryDto[]>('/jobs/ai'),
  jobAi: (jobId: number) => request<JobAiDetailDto>(`/jobs/${jobId}/ai`),
  analyzeJob: (jobId: number) => request<{ queued: string[]; reason: string | null }>(`/jobs/${jobId}/ai/analyze`, post()),
  tailored: (jobId: number) => request<TailoredStateDto>(`/jobs/${jobId}/tailored`),
  requestTailored: (jobId: number) => request<{ queued: boolean }>(`/jobs/${jobId}/tailored`, post()),
  saveTailored: (jobId: number, draft: TailoredDraft) => request<TailoredSaveDto>(`/jobs/${jobId}/tailored`, json('PUT', draft)),

  // --- aba Configurações ---
  settings: () => request<SettingsDto>('/settings'),
  saveSettings: (patch: SettingsPatch) => request<SettingsDto>('/settings', json('PATCH', patch)),
  /** A chave só viaja neste PUT; nenhuma resposta a devolve. */
  saveApiKey: (provider: AiProviderId, key: string) => request<AiKeyMetaDto>(`/settings/ai-keys/${provider}`, json('PUT', { key })),
  deleteApiKey: (provider: AiProviderId) => request<void>(`/settings/ai-keys/${provider}`, { method: 'DELETE' }),
  /** Sem corpo: o servidor usa um prompt fixo. Limite de frequência: 429 com a mensagem pronta. */
  testConnection: () => request<TestConnectionDto>('/settings/ai/test', post()),
};

/** Links de download: mesma origem, abertos pelo navegador (não passam pelo `fetch`). */
export const tailoredPdfUrl = (jobId: number) => `/api/jobs/${jobId}/tailored.pdf`;
export const resumeFileUrl = (lang: ResumeLang) => `/api/ai/resumes/${lang}/file`;
