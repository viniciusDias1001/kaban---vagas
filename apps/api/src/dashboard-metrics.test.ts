import { describe, expect, it } from 'vitest';
import type { AppliedJobFact, MailFacts } from '@kv/db';
import { AI_LAYERS, EMAIL_KINDS, type EmailKind, type UsageByLayer } from '@kv/shared';
import { buildDashboard, median } from './dashboard-metrics';

const DAY = 86_400_000;
const zeroUsage = Object.fromEntries(AI_LAYERS.map((l) => [l, 0])) as UsageByLayer;
const emptyMail: MailFacts = {
  received: Object.fromEntries(EMAIL_KINDS.map((k) => [k, 0])) as Record<EmailKind, number>,
  waiting: 0, repliedAuto: 0, repliedApproved: 0, discarded: 0, replyMinutes: [],
};
let seq = 0;
const fact = (over: Partial<AppliedJobFact> = {}): AppliedJobFact => {
  seq += 1;
  return {
    jobId: seq, source: 'gupy', column: 'aplicada', appliedBy: 'humano', site: null, score: null, resumeLang: null,
    appliedAt: 0, firstResponseAt: null, interviewAt: null, offerAt: null, lostAt: null, ...over,
  };
};
const base = { period: '30' as const, since: 0, blockers: [], mail: emptyMail, usage: zeroUsage };

describe('median', () => {
  it('takes the median', () => {
    expect(median([])).toBeNull();
    expect(median([4])).toBe(4);
    expect(median([1, 9, 3])).toBe(3);
    expect(median([1, 3, 5, 9])).toBe(4);
  });
});

describe('buildDashboard', () => {
  it('builds the numbers of the period', () => {
    const dto = buildDashboard({
      ...base, usage: { ...zeroUsage, apply: 0.6, email: 0.3 },
      facts: [
        fact({ appliedBy: 'ia', site: 'greenhouse', score: 85, resumeLang: 'pt-BR', appliedAt: 0, firstResponseAt: 2 * DAY, interviewAt: 2 * DAY }),
        fact({ appliedBy: 'ia', site: 'lever', score: 92, resumeLang: 'en', appliedAt: 0, firstResponseAt: 4 * DAY, lostAt: 4 * DAY }),
        fact({ appliedBy: 'humano', site: null, score: null, resumeLang: null, appliedAt: 0 }),
      ],
    });
    expect(dto.applied).toEqual({ total: 3, byAi: 2, byOwner: 1 });
    expect(dto.responded).toEqual({ n: 2, of: 3 });
    expect(dto.interviews).toEqual({ n: 1, of: 3 });
    expect(dto.offers).toEqual({ n: 0, of: 3 });
    expect(dto.rejections).toEqual({ n: 1, of: 3 });
    expect(dto.funnel).toEqual({ applied: 3, responded: 2, interview: 1, offer: 0, lost: 1 });
    expect(dto.timing).toEqual({ firstResponseDays: 3, firstResponseBase: 2, rejectionDays: 4, rejectionBase: 1 });
    expect(dto.cost.total).toBeCloseTo(0.9, 10);
    expect(dto.cost.perApplication).toBeCloseTo(0.3, 10);
    expect(dto.breakdowns.site.map((r) => r.key)).toEqual(['greenhouse', 'lever', 'outside']);
    expect(dto.breakdowns.score.find((r) => r.key === 'none')).toEqual({ key: 'none', applied: 1, responded: 0, interviews: 0 });
    expect(dto.breakdowns.resumeLang.map((r) => r.key).sort()).toEqual(['en', 'none', 'pt-BR']);
    expect(dto.breakdowns.appliedBy).toEqual([
      { key: 'ia', applied: 2, responded: 2, interviews: 1 },
      { key: 'humano', applied: 1, responded: 0, interviews: 0 },
    ]);
  });

  it('keeps the funnel from growing', () => {
    // oferta sem entrevista; e um card que respondeu só por movimento do dono
    const dto = buildDashboard({ ...base, facts: [fact({ firstResponseAt: 1, offerAt: 1 }), fact({ firstResponseAt: 2, interviewAt: 2 })] });
    const f = dto.funnel;
    expect(f.applied >= f.responded && f.responded >= f.interview && f.interview >= f.offer).toBe(true);
    expect(f).toMatchObject({ interview: 2, offer: 1 });
  });

  it('counts a reply that came before the application but gives it no timing sample', () => {
    const dto = buildDashboard({
      ...base,
      facts: [
        fact({ appliedAt: 5 * DAY, firstResponseAt: 3 * DAY, lostAt: 4 * DAY }),
        fact({ appliedAt: 0, firstResponseAt: 2 * DAY, lostAt: 6 * DAY }),
      ],
    });
    expect(dto.responded).toEqual({ n: 2, of: 2 });
    expect(dto.rejections).toEqual({ n: 2, of: 2 });
    expect(dto.funnel.lost).toBe(2);
    expect(dto.timing).toEqual({ firstResponseDays: 2, firstResponseBase: 1, rejectionDays: 6, rejectionBase: 1 });
  });

  it('has no NaN or Infinity with nothing to show', () => {
    const dto = buildDashboard({ ...base, period: '7', facts: [] });
    expect(dto.cost.perApplication).toBeNull();
    expect(dto.timing).toEqual({ firstResponseDays: null, firstResponseBase: 0, rejectionDays: null, rejectionBase: 0 });
    expect(JSON.stringify(dto)).not.toMatch(/NaN|Infinity/);
    expect(Object.values(dto.breakdowns).every((rows) => rows.length === 0)).toBe(true);
    expect(dto.email).toMatchObject({ receivedTotal: 0, replyMinutes: null, replyBase: 0 });
  });

  it('summarises mail', () => {
    const mail: MailFacts = {
      ...emptyMail, received: { ...emptyMail.received, pedido: 2, reprovacao: 1 }, waiting: 3, replyMinutes: [5, 120],
    };
    const dto = buildDashboard({ ...base, facts: [], mail });
    expect(dto.email).toMatchObject({ receivedTotal: 3, waiting: 3, replyMinutes: 63, replyBase: 2 });
  });
});
