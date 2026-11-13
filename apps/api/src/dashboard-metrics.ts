import type { AppliedJobFact, MailFacts } from '@kv/db';
import { scoreBand, type BreakdownRow, type DashboardDto, type DashboardPeriod, type UsageByLayer } from '@kv/shared';

const DAY_MS = 86_400_000;

/** Mediana; com número par de valores, a média dos dois do meio; lista vazia: null. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Dias entre `from` e cada `to` (uma casa decimal). Um `to` anterior ao `from` (o recrutador escreveu antes de o
 * dono aplicar) não dá amostra: o tempo seria negativo.
 */
function medianDays(pairs: { from: number; to: number | null }[]): { days: number | null; base: number } {
  const samples: number[] = [];
  for (const { from, to } of pairs) if (to !== null && to >= from) samples.push((to - from) / DAY_MS);
  const m = median(samples);
  return { days: m === null ? null : Math.round(m * 10) / 10, base: samples.length };
}

function breakdown(facts: AppliedJobFact[], keyOf: (f: AppliedJobFact) => string, answered: (f: AppliedJobFact) => boolean, interviewed: (f: AppliedJobFact) => boolean): BreakdownRow[] {
  const rows = new Map<string, BreakdownRow>();
  for (const f of facts) {
    const key = keyOf(f);
    const row = rows.get(key) ?? { key, applied: 0, responded: 0, interviews: 0 };
    row.applied += 1;
    if (answered(f)) row.responded += 1;
    if (interviewed(f)) row.interviews += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.applied - a.applied || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function buildDashboard(input: {
  period: DashboardPeriod; since: number | null; facts: AppliedJobFact[];
  blockers: DashboardDto['blockers']; mail: MailFacts; usage: UsageByLayer;
}): DashboardDto {
  const { facts, mail, usage } = input;
  const total = facts.length;
  // Uma vaga com entrevista ou oferta respondeu, mesmo que o primeiro sinal não esteja registrado: o funil nunca cresce.
  const interviewed = (f: AppliedJobFact) => f.interviewAt !== null || f.offerAt !== null;
  const answered = (f: AppliedJobFact) => f.firstResponseAt !== null || interviewed(f);
  const count = (pred: (f: AppliedJobFact) => boolean) => facts.filter(pred).length;
  const responded = count(answered);
  const interviews = count(interviewed);
  const offers = count((f) => f.offerAt !== null);
  const lost = count((f) => f.lostAt !== null);
  const byAi = count((f) => f.appliedBy === 'ia');

  const first = medianDays(facts.map((f) => ({ from: f.appliedAt, to: f.firstResponseAt })));
  const rejection = medianDays(facts.map((f) => ({ from: f.appliedAt, to: f.lostAt })));

  const costTotal = Object.values(usage).reduce((sum, v) => sum + v, 0);
  const rows = (keyOf: (f: AppliedJobFact) => string) => breakdown(facts, keyOf, answered, interviewed);
  const replyMedian = median(mail.replyMinutes);

  return {
    period: input.period, since: input.since,
    applied: { total, byAi, byOwner: total - byAi },
    responded: { n: responded, of: total },
    interviews: { n: interviews, of: total },
    offers: { n: offers, of: total },
    rejections: { n: lost, of: total },
    funnel: { applied: total, responded, interview: interviews, offer: offers, lost },
    breakdowns: {
      site: rows((f) => f.site ?? 'outside'),
      source: rows((f) => f.source),
      score: rows((f) => scoreBand(f.score)),
      resumeLang: rows((f) => f.resumeLang ?? 'none'),
      appliedBy: rows((f) => f.appliedBy),
    },
    timing: { firstResponseDays: first.days, firstResponseBase: first.base, rejectionDays: rejection.days, rejectionBase: rejection.base },
    blockers: input.blockers,
    cost: { total: costTotal, perApplication: total > 0 ? costTotal / total : null, byLayer: usage },
    email: {
      received: mail.received,
      receivedTotal: Object.values(mail.received).reduce((sum, v) => sum + v, 0),
      waiting: mail.waiting, repliedAuto: mail.repliedAuto, repliedApproved: mail.repliedApproved, discarded: mail.discarded,
      replyMinutes: replyMedian === null ? null : Math.round(replyMedian), replyBase: mail.replyMinutes.length,
    },
  };
}
