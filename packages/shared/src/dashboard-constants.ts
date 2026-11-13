/**
 * Parte de `@kv/shared` sobre o Painel que NÃO depende de Zod: períodos, faixas de nota e o DTO que a API devolve.
 * É o que o navegador recebe por `@kv/shared/client`: nada aqui importa `zod` nem `./schemas` em tempo de execução.
 */
import type { UsageByLayer } from './ai-constants';
import type { EmailKind } from './email-constants';

export const DASHBOARD_PERIODS = ['7', '30', '90', 'all'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = '30';
export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  '7': '7 dias', '30': '30 dias', '90': '90 dias', all: 'Tudo',
};

const DAY_MS = 86_400_000;

/** O início do período em epoch ms, ou null para "tudo". */
export function periodSince(period: DashboardPeriod, now: number): number | null {
  return period === 'all' ? null : now - Number(period) * DAY_MS;
}

export interface Ratio { n: number; of: number }

export const SCORE_BANDS = ['90+', '80-89', '70-79', 'below-70', 'none'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];
export function scoreBand(score: number | null): ScoreBand {
  if (score === null) return 'none';
  if (score >= 90) return '90+';
  if (score >= 80) return '80-89';
  if (score >= 70) return '70-79';
  return 'below-70';
}

export interface BreakdownRow { key: string; applied: number; responded: number; interviews: number }

export interface DashboardDto {
  period: DashboardPeriod; since: number | null;
  applied: { total: number; byAi: number; byOwner: number };
  /** `of` é sempre `applied.total`. */
  responded: Ratio; interviews: Ratio; offers: Ratio; rejections: Ratio;
  funnel: { applied: number; responded: number; interview: number; offer: number; lost: number };
  /** Chaves: site = ApplySiteId ou 'outside'; source = id da fonte; score = ScoreBand; resumeLang = 'pt-BR' | 'en' | 'none'; appliedBy = 'ia' | 'humano'. Só linhas com `applied` > 0, da maior para a menor. */
  breakdowns: { site: BreakdownRow[]; source: BreakdownRow[]; score: BreakdownRow[]; resumeLang: BreakdownRow[]; appliedBy: BreakdownRow[] };
  timing: { firstResponseDays: number | null; firstResponseBase: number; rejectionDays: number | null; rejectionBase: number };
  /** Do mais frequente ao menos. */
  blockers: { kind: 'needs_human' | 'skipped'; reason: string; count: number }[];
  cost: { total: number; perApplication: number | null; byLayer: UsageByLayer };
  email: {
    received: Record<EmailKind, number>; receivedTotal: number; waiting: number; repliedAuto: number; repliedApproved: number;
    discarded: number; replyMinutes: number | null; replyBase: number;
  };
}
