import { APPLY_SITE_LABELS, type ApplicationReason, type ApplySiteId, type DashboardDto, type Ratio } from '@kv/shared/client';
import { APPLIED_BY_OWNER_LABEL, reasonText } from './apply';

/** Textos do Painel (sem React). Os números saem com vírgula decimal, sem depender do idioma da máquina. */

/** Número com `digits` casas e vírgula decimal. */
const decimal = (value: number, digits: number): string => value.toFixed(digits).replace('.', ',');

/** Uma casa decimal; sem a casa quando o valor é inteiro ("2", "1,5"). */
const short = (value: number): string => {
  const text = decimal(value, 1);
  return text.endsWith(',0') ? text.slice(0, -2) : text;
};

const NO_DATA = 'sem dados';

/** Base de 10 ou mais: "25% (3 de 12)". Base de 1 a 9: "3 de 8". Base 0: "sem dados". */
export function ratioText(r: Ratio): string {
  if (r.of <= 0) return NO_DATA;
  if (r.of < 10) return `${r.n} de ${r.of}`;
  return `${Math.round((r.n / r.of) * 100)}% (${r.n} de ${r.of})`;
}

/** Para barras: n/of entre 0 e 1; 0 quando `of` é 0. */
export function ratioShare(r: Ratio): number {
  if (r.of <= 0) return 0;
  return Math.min(1, Math.max(0, r.n / r.of));
}

export function daysText(days: number | null, base: number): string {
  if (days === null) return NO_DATA;
  return `${decimal(days, 1)} dias (${base} ${base === 1 ? 'resposta' : 'respostas'})`;
}

export function usdText(value: number | null): string {
  return value === null ? NO_DATA : `US$ ${decimal(value, 2)}`;
}

export function minutesText(minutes: number | null): string {
  if (minutes === null) return NO_DATA;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${short(minutes / 60)} h`;
  const days = minutes / 1440;
  return `${short(days)} ${days < 2 ? 'dia' : 'dias'}`;
}

const SCORE_LABELS: Record<string, string> = {
  '90+': '90 ou mais', '80-89': '80 a 89', '70-79': '70 a 79', 'below-70': 'Abaixo de 70', none: 'Sem nota',
};
const RESUME_LABELS: Record<string, string> = { 'pt-BR': 'Português', en: 'Inglês', none: 'Sem currículo do app' };
const APPLIED_BY_LABELS: Record<string, string> = { ia: 'Pela IA', humano: 'Por você' };

export function breakdownLabel(
  dimension: keyof DashboardDto['breakdowns'], key: string, sources: { id: string; name: string }[],
): string {
  switch (dimension) {
    case 'site': return key === 'outside' ? 'Fora do app' : (APPLY_SITE_LABELS[key as ApplySiteId] ?? key);
    case 'source': return sources.find((s) => s.id === key)?.name ?? key;
    case 'score': return SCORE_LABELS[key] ?? key;
    case 'resumeLang': return RESUME_LABELS[key] ?? key;
    case 'appliedBy': return APPLIED_BY_LABELS[key] ?? key;
  }
}

/** O texto que a aba Candidaturas mostra para o motivo; o próprio motivo quando não há texto. */
export function blockerLabel(kind: 'needs_human' | 'skipped', reason: string): string {
  if (kind === 'skipped' && reason === 'already_applied') return APPLIED_BY_OWNER_LABEL;
  return reasonText(reason as ApplicationReason, null) || reason;
}

/** Larguras das etapas do funil, de 0 a 1, relativas a `applied`; etapa com 0 fica com 0. */
export function funnelShares(f: DashboardDto['funnel']): { applied: number; responded: number; interview: number; offer: number } {
  const share = (n: number) => (f.applied <= 0 ? 0 : Math.min(1, Math.max(0, n / f.applied)));
  return { applied: share(f.applied), responded: share(f.responded), interview: share(f.interview), offer: share(f.offer) };
}

/** O texto de um bloco sem dados, ou null se há o que mostrar. */
export function emptyReason(
  block: 'kpis' | 'funnel' | 'breakdowns' | 'timing' | 'blockers' | 'cost' | 'email', dto: DashboardDto,
): string | null {
  switch (block) {
    case 'kpis':
    case 'funnel':
    case 'breakdowns':
      return dto.applied.total === 0 ? 'Ainda não há candidaturas neste período.' : null;
    case 'timing':
      return dto.timing.firstResponseBase === 0 && dto.timing.rejectionBase === 0
        ? 'Ainda não há respostas de empresas neste período.' : null;
    case 'blockers':
      return dto.blockers.length === 0 ? 'Nenhuma candidatura travou neste período.' : null;
    case 'cost':
      return dto.cost.total === 0 ? 'Sem gasto de IA neste período.' : null;
    case 'email':
      return dto.email.receivedTotal === 0
        ? 'Nenhum e-mail de vaga neste período. Conecte a caixa em Configurações > E-mail.' : null;
  }
}
