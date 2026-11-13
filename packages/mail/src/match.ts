import { companyInHeaders, companyInText } from './company';
import type { RawMail } from './types';

export interface MatchCandidate {
  jobId: number;
  company: string;
  title: string;
  appliedAt: number;
}

const DAY_MS = 86_400_000;
const WINDOW_BEFORE_DAYS = 120;
const WINDOW_AFTER_DAYS = 1;
const MAX_CANDIDATES = 5;

/**
 * Com `linkedJobId` (o fio já é de um card): só ele. Senão: itens de `pool` cuja empresa aparece nos cabeçalhos do e-mail e
 * com `appliedAt` entre 120 dias antes e 1 dia depois da data do e-mail; mais recentes primeiro; no máximo 5.
 */
export function pickCandidates(
  mail: Pick<RawMail, 'from' | 'subject' | 'date'>,
  pool: readonly MatchCandidate[],
  linkedJobId: number | null,
): MatchCandidate[] {
  if (linkedJobId !== null) return pool.filter((c) => c.jobId === linkedJobId).slice(0, 1);
  const from = mail.date - WINDOW_BEFORE_DAYS * DAY_MS;
  const to = mail.date + WINDOW_AFTER_DAYS * DAY_MS;
  return pool
    .filter((c) => c.appliedAt >= from && c.appliedAt <= to && companyInHeaders(c.company, mail))
    .sort((a, b) => b.appliedAt - a.appliedAt)
    .slice(0, MAX_CANDIDATES);
}

/** A escolha do modelo só vale se é uma das candidatas e a empresa dela aparece no remetente, no assunto ou no texto. */
export function acceptMatch(
  jobId: number | null,
  mail: Pick<RawMail, 'from' | 'subject' | 'text'>,
  candidates: readonly MatchCandidate[],
): number | null {
  if (jobId === null) return null;
  const chosen = candidates.find((c) => c.jobId === jobId);
  if (!chosen) return null;
  return companyInHeaders(chosen.company, mail) || companyInText(chosen.company, mail.text) ? chosen.jobId : null;
}
