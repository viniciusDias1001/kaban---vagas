import { describe, expect, it } from 'vitest';
import { acceptMatch, pickCandidates, type MatchCandidate } from './match';
import { rawMail } from './testing';

const DAY = 86_400_000;
const D = 1_700_000_000_000;
const pool: MatchCandidate[] = [
  { jobId: 1, company: 'Acme', title: 'Dev', appliedAt: D - 10 * DAY },
  { jobId: 2, company: 'Acme', title: 'Dev antiga', appliedAt: D - 200 * DAY },
  { jobId: 3, company: 'Globex', title: 'Dev', appliedAt: D - 5 * DAY },
];

describe('pickCandidates', () => {
  it('offers only recent applications of the company in the headers, newest first', () => {
    expect(pickCandidates(rawMail({ subject: 'Sua candidatura na Acme', date: D }), pool, null).map((c) => c.jobId)).toEqual([1]);
  });

  it('offers only the linked card when the thread already has one', () => {
    expect(pickCandidates(rawMail({ subject: 'Re: conversa', date: D }), pool, 3).map((c) => c.jobId)).toEqual([3]);
  });

  it('offers nothing when the linked card is not in the pool', () => {
    expect(pickCandidates(rawMail({ date: D }), pool, 99)).toEqual([]);
  });

  it('caps the list at five, the most recent ones', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ jobId: 10 + i, company: 'Acme', title: 'Dev', appliedAt: D - (i + 1) * DAY }));
    const got = pickCandidates(rawMail({ subject: 'Acme', date: D }), many, null).map((c) => c.jobId);
    expect(got).toEqual([10, 11, 12, 13, 14]);
  });

  it('sorts newest first', () => {
    const two: MatchCandidate[] = [
      { jobId: 1, company: 'Acme', title: 'a', appliedAt: D - 30 * DAY },
      { jobId: 2, company: 'Acme', title: 'b', appliedAt: D - 3 * DAY },
    ];
    expect(pickCandidates(rawMail({ subject: 'Acme', date: D }), two, null).map((c) => c.jobId)).toEqual([2, 1]);
  });

  it('keeps the window edges: 120 days before and 1 day after the mail', () => {
    const edge: MatchCandidate[] = [
      { jobId: 1, company: 'Acme', title: 'a', appliedAt: D - 120 * DAY },
      { jobId: 2, company: 'Acme', title: 'b', appliedAt: D - 120 * DAY - 1 },
      { jobId: 3, company: 'Acme', title: 'c', appliedAt: D + DAY },
      { jobId: 4, company: 'Acme', title: 'd', appliedAt: D + DAY + 1 },
    ];
    expect(pickCandidates(rawMail({ subject: 'Acme', date: D }), edge, null).map((c) => c.jobId)).toEqual([3, 1]);
  });

  it('does not match a company that is only in the body', () => {
    expect(pickCandidates(rawMail({ from: { address: 'x@ats.example', name: 'Recrutamento' }, subject: 'Olá', text: 'Acme Acme', date: D }), pool, null)).toEqual([]);
  });
});

describe('acceptMatch', () => {
  const cands = [{ jobId: 1, company: 'Acme', title: 'Dev', appliedAt: 0 }];

  it('accepts a choice only among the candidates and with the company in the mail', () => {
    expect(acceptMatch(1, rawMail({ subject: 'Acme: próximos passos' }), cands)).toBe(1);
    expect(acceptMatch(2, rawMail({ subject: 'Acme: próximos passos' }), cands)).toBeNull();
    expect(acceptMatch(1, rawMail({ from: { address: 'x@ats.example', name: 'Recrutamento' }, subject: 'Olá', text: 'Sem nome da empresa' }), cands)).toBeNull();
    expect(acceptMatch(null, rawMail({}), cands)).toBeNull();
  });

  it('accepts the company found only in the text', () => {
    expect(acceptMatch(1, rawMail({ from: { address: 'x@ats.example', name: 'Recrutamento' }, subject: 'Olá', text: 'Vaga na Acme.' }), cands)).toBe(1);
  });
});
