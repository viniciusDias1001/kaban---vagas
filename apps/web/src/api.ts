import type {
  HealthDto, JobDetailDto, JobDto, JobListItemDto, JobPatch, ProfileDto, ProfileInput, SourceDto, StatsDto,
} from '@kv/shared/client';
import { ApiError, NETWORK_ERROR, errorMessage } from './apiError';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
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
    // 200 que não é JSON: um proxy ou página de login no caminho.
    throw new ApiError(res.status, 'A API respondeu algo inesperado. Confira se ela está no ar e tente de novo.');
  }
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  /**
   * O quadro inteiro, sem as descrições. O filtro de texto é aplicado no cliente. De propósito sem
   * AbortSignal: uma consulta cancelada pelo React Query (ao mover um card) tem o resultado descartado,
   * mas a requisição termina normalmente, sem aparecer como falha de rede no navegador.
   */
  jobs: () => http<JobListItemDto[]>('/jobs'),
  job: (id: number) => http<JobDetailDto>(`/jobs/${id}`),
  patchJob: (id: number, patch: JobPatch) => http<JobDto>(`/jobs/${id}`, json('PATCH', patch)),
  profiles: () => http<ProfileDto[]>('/profiles'),
  createProfile: (input: ProfileInput) => http<ProfileDto>('/profiles', json('POST', input)),
  updateProfile: (id: number, patch: Partial<ProfileInput>) => http<ProfileDto>(`/profiles/${id}`, json('PATCH', patch)),
  deleteProfile: (id: number) => http<void>(`/profiles/${id}`, { method: 'DELETE' }),
  runNow: (profileId: number) => http<{ queued: number }>('/runs', json('POST', { profileId })),
  health: () => http<HealthDto>('/runs/health'),
  stats: () => http<StatsDto>('/stats'),
  sources: () => http<SourceDto[]>('/sources'),
};
