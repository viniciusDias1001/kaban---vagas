import type {
  AiStatusDto, AiUsageDto, AnalyzeResultDto, CandidateProfileDto, JobAiDetailDto, JobAiListItemDto, ProfileOverviewDto, ProfileWire,
  AiKeyMetaDto, AiProviderId, ResumeLang, ResumeMetaDto, SettingsDto, SettingsPatch, TailoredDraft, TailoredSaveDto,
  TailoredStateDto, TestConnectionDto,
} from '@kv/shared/client';
import { ApiError, NETWORK_ERROR, errorMessage } from './apiError';
import { parsePdfFailure, type PdfFailure } from './lib/ai';

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
  /** `version` = a versão do perfil em que o rascunho se baseia: a API responde 409 se o servidor já tem outra. */
  saveProfile: (lang: ResumeLang, data: ProfileWire, version: number) =>
    request<CandidateProfileDto>(`/ai/profile/${lang}`, json('PUT', { data, version })),
  translateProfile: (lang: ResumeLang) => request<{ queued: boolean }>(`/ai/profile/${lang}/translate`, post()),
  confirmTask: (taskId: number) => request<{ queued: boolean }>(`/ai/tasks/${taskId}/confirm`, post()),
  jobScores: () => request<JobAiListItemDto[]>('/jobs/ai'),
  jobAi: (jobId: number) => request<JobAiDetailDto>(`/jobs/${jobId}/ai`),
  /**
   * `explicit` = o usuário clicou ("Analisar esta vaga", "Tentar de novo"). Sem ele (abrir a vaga), a API não refaz
   * uma camada que terminou em erro.
   */
  analyzeJob: (jobId: number, explicit = false) =>
    request<AnalyzeResultDto>(`/jobs/${jobId}/ai/analyze`, explicit ? json('POST', { explicit: true }) : post()),
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

/**
 * Confere se o PDF sairia, ANTES de mandar o navegador baixá-lo. A rota pode recusar (409 `verification_failed`,
 * 409 `profile_missing`, 422 `pdf_unavailable`), e um link de download que recebe um erro salvaria o JSON do
 * erro como se fosse o arquivo, ou tiraria o usuário da página. Então: um `fetch` na mesma origem (permitido
 * pela CSP, `connect-src 'self'`) lê a resposta; se deu certo, quem chama dispara o download pela mesma URL
 * (`startDownload`), e é o navegador que grava o arquivo, com o nome do `content-disposition`.
 *
 * De propósito sem `blob:`: a CSP das páginas (apps/api/src/app.ts) não cita `blob:` em diretiva nenhuma, e
 * salvar por um object URL dependeria de como cada navegador trata isso. O custo é o servidor desenhar o PDF
 * duas vezes (o currículo é pequeno; a rota já desenha um de cada vez).
 *
 * Devolve null quando o PDF está disponível, ou a falha pronta para a tela.
 */
export async function checkTailoredPdf(jobId: number): Promise<PdfFailure | null> {
  let res: Response;
  try {
    res = await fetch(tailoredPdfUrl(jobId), { cache: 'no-store' });
  } catch {
    return parsePdfFailure(0, '');
  }
  if (res.ok) {
    // Lê até o fim: abandonar o corpo pela metade aparece como requisição abortada no navegador.
    await res.arrayBuffer().catch(() => undefined);
    return null;
  }
  return parsePdfFailure(res.status, await res.text().catch(() => ''));
}

/** Manda o navegador baixar uma URL da mesma origem, sem sair da página (um link `download` clicado em código). */
export function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}
export const resumeFileUrl = (lang: ResumeLang) => `/api/ai/resumes/${lang}/file`;
