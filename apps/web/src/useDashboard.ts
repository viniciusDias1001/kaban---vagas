import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DashboardPeriod } from '@kv/shared/client';
import { getDashboard } from './dashboardApi';

export const DASHBOARD_REFETCH_MS = 60_000;

/** O Painel do período: relido a cada 60 s; ao trocar de período, os números antigos ficam na tela até os novos chegarem. */
export function useDashboard(period: DashboardPeriod) {
  return useQuery({
    queryKey: ['dashboard', period],
    queryFn: () => getDashboard(period),
    refetchInterval: DASHBOARD_REFETCH_MS,
    placeholderData: keepPreviousData,
    // O Painel mostra o erro na própria página, com "Tentar de novo": sem o aviso flutuante repetindo a frase.
    meta: { inlineError: true },
  });
}
