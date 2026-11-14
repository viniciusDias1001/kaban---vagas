import { describe, expect, it } from 'vitest';
import type { DashboardDto } from '@kv/shared/client';
import {
  FIRST_READ_PERIOD, blockerLabel, breakdownLabel, daysText, emptyReason, funnelShares, minutesText, painelStartPeriod, ratioShare,
  ratioText, usdText,
} from './dashboard';

describe('painelStartPeriod', () => {
  it('opens on the period the navigation asks for, else on the last one chosen', () => {
    // "Abrir a lista" do resumo da primeira leitura: os e-mails contados são dos últimos 30 dias.
    expect(FIRST_READ_PERIOD).toBe('30');
    expect(painelStartPeriod(FIRST_READ_PERIOD, '7')).toBe('30');
    expect(painelStartPeriod(FIRST_READ_PERIOD, 'all')).toBe('30');
    expect(painelStartPeriod(undefined, '7')).toBe('7');
  });
});

const zeroKinds = { confirmation: 0, interview: 0, rejection: 0, offer: 0, question: 0, other: 0 } as unknown as DashboardDto['email']['received'];
const emptyDto: DashboardDto = {
  period: '30', since: null,
  applied: { total: 0, byAi: 0, byOwner: 0 },
  responded: { n: 0, of: 0 }, interviews: { n: 0, of: 0 }, offers: { n: 0, of: 0 }, rejections: { n: 0, of: 0 },
  funnel: { applied: 0, responded: 0, interview: 0, offer: 0, lost: 0 },
  breakdowns: { site: [], source: [], score: [], resumeLang: [], appliedBy: [] },
  timing: { firstResponseDays: null, firstResponseBase: 0, rejectionDays: null, rejectionBase: 0 },
  blockers: [],
  cost: { total: 0, perApplication: null, byLayer: {} as DashboardDto['cost']['byLayer'] },
  email: { received: zeroKinds, receivedTotal: 0, waiting: 0, repliedAuto: 0, repliedApproved: 0, discarded: 0, replyMinutes: null, replyBase: 0 },
};
const filledDto: DashboardDto = {
  ...emptyDto,
  applied: { total: 12, byAi: 8, byOwner: 4 },
  timing: { firstResponseDays: 3, firstResponseBase: 2, rejectionDays: null, rejectionBase: 0 },
  blockers: [{ kind: 'needs_human', reason: 'captcha', count: 2 }],
  cost: { total: 0.3, perApplication: 0.025, byLayer: {} as DashboardDto['cost']['byLayer'] },
  email: { ...emptyDto.email, receivedTotal: 4 },
};

describe('dashboard formatting', () => {
  it('shows a percentage only with a base of ten or more', () => {
    expect(ratioText({ n: 3, of: 12 })).toBe('25% (3 de 12)');
    expect(ratioText({ n: 3, of: 8 })).toBe('3 de 8');
    expect(ratioText({ n: 1, of: 1 })).toBe('1 de 1');
    expect(ratioText({ n: 0, of: 0 })).toBe('sem dados');
  });
  it('never divides by zero', () => {
    expect(ratioShare({ n: 0, of: 0 })).toBe(0);
    expect(ratioShare({ n: 3, of: 12 })).toBe(0.25);
  });
  it('formats days, dollars and minutes in Portuguese', () => {
    expect(daysText(3, 2)).toBe('3,0 dias (2 respostas)');
    expect(daysText(1.25, 1)).toBe('1,3 dias (1 resposta)');
    expect(daysText(null, 0)).toBe('sem dados');
    expect(usdText(0.3)).toBe('US$ 0,30');
    expect(usdText(null)).toBe('sem dados');
    expect(minutesText(5)).toBe('5 min');
    expect(minutesText(120)).toBe('2 h');
    expect(minutesText(2160)).toBe('1,5 dia');
    expect(minutesText(4320)).toBe('3 dias');
    expect(minutesText(null)).toBe('sem dados');
  });
  it('picks singular or plural from the rounded number it shows', () => {
    // 1,99 dia aparece como "2": o plural vem do número mostrado, não do valor antes de arredondar.
    expect(minutesText(1440 * 1.99)).toBe('2 dias');
    expect(minutesText(1440 * 1.04)).toBe('1 dia');
    expect(daysText(0.96, 1)).toBe('1,0 dia (1 resposta)');
    expect(daysText(1.04, 2)).toBe('1,0 dia (2 respostas)');
    expect(daysText(1.06, 2)).toBe('1,1 dias (2 respostas)');
  });
  it('labels breakdown rows', () => {
    expect(breakdownLabel('site', 'outside', [])).toBe('Fora do app');
    expect(breakdownLabel('site', 'greenhouse', [])).toBe('Greenhouse');
    expect(breakdownLabel('score', '90+', [])).toBe('90 ou mais');
    expect(breakdownLabel('score', 'below-70', [])).toBe('Abaixo de 70');
    expect(breakdownLabel('source', 'gupy', [{ id: 'gupy', name: 'Gupy' }])).toBe('Gupy');
    expect(breakdownLabel('source', 'x', [])).toBe('x');
    expect(breakdownLabel('resumeLang', 'en', [])).toBe('Inglês');
    expect(breakdownLabel('resumeLang', 'none', [])).toBe('Sem currículo do app');
    expect(breakdownLabel('appliedBy', 'humano', [])).toBe('Por você');
    expect(breakdownLabel('appliedBy', 'ia', [])).toBe('Pela IA');
  });
  it('reuses the Candidaturas wording for blockers and falls back to the reason', () => {
    expect(blockerLabel('needs_human', 'captcha')).toBe('O site pediu para resolver um captcha.');
    expect(blockerLabel('skipped', 'already_applied')).toBe('Aplicada por você');
    expect(blockerLabel('skipped', 'something_new')).toBe('something_new');
  });
  it('sizes the funnel against the applications', () => {
    expect(funnelShares({ applied: 10, responded: 5, interview: 2, offer: 0, lost: 3 })).toEqual({ applied: 1, responded: 0.5, interview: 0.2, offer: 0 });
    expect(funnelShares({ applied: 0, responded: 0, interview: 0, offer: 0, lost: 0 })).toEqual({ applied: 0, responded: 0, interview: 0, offer: 0 });
  });
  it('says what is missing in an empty block', () => {
    expect(emptyReason('kpis', emptyDto)).toBe('Ainda não há candidaturas neste período.');
    expect(emptyReason('kpis', filledDto)).toBeNull();
    expect(emptyReason('email', emptyDto)).toContain('Conecte a caixa');
    expect(emptyReason('timing', emptyDto)).toBe('Ainda não há respostas de empresas neste período.');
    expect(emptyReason('blockers', emptyDto)).toBe('Nenhuma candidatura travou neste período.');
    expect(emptyReason('cost', emptyDto)).toBe('Sem gasto de IA neste período.');
    for (const b of ['funnel', 'breakdowns', 'timing', 'blockers', 'cost', 'email'] as const) expect(emptyReason(b, filledDto)).toBeNull();
  });
});
