import type {
  HealthDto, JobDetailDto, JobDto, JobPatch, ProfileDto, ProfileInput, SourceDto, StatsDto,
} from '@kv/shared';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  jobs: (q = '') => http<JobDto[]>(`/jobs${q ? `?q=${encodeURIComponent(q)}` : ''}`),
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
