import type { DashboardDto, DashboardPeriod } from '@kv/shared/client';
import { ApiError, NETWORK_ERROR, errorMessage } from './apiError';

/** GET /dashboard?period=: todos os números do Painel, calculados no servidor. */
export async function getDashboard(period: DashboardPeriod): Promise<DashboardDto> {
  let res: Response;
  try {
    res = await fetch(`/api/dashboard?period=${encodeURIComponent(period)}`);
  } catch {
    throw new ApiError(0, NETWORK_ERROR);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, errorMessage(res.status, text));
  }
  try {
    return (await res.json()) as DashboardDto;
  } catch {
    throw new ApiError(res.status, 'A API respondeu algo inesperado. Confira se ela está no ar e tente de novo.');
  }
}
