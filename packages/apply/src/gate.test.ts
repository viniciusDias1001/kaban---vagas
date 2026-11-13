import { describe, expect, it } from 'vitest';
import { APPLY_DEFAULTS } from '@kv/shared';
import { capsLeft, decideGate, isBlocked, nextAllowedAt, withinWindow } from './gate';

describe('gate', () => {
  it('blocks by company and by term, ignoring case and accents', () => {
    expect(isBlocked({ company: 'Empresa Atual S.A.', title: 'Dev', description: '' }, { blockedCompanies: ['empresa atual'], blockedTerms: [] })).toBe('empresa atual');
    expect(isBlocked({ company: 'Acme', title: 'Estágio em TI', description: '' }, { blockedCompanies: [], blockedTerms: ['estagio'] })).toBe('estagio');
    expect(isBlocked({ company: 'Acme', title: 'Dev', description: '' }, { blockedCompanies: ['empresa atual'], blockedTerms: [] })).toBeNull();
  });
  it('matches whole words only, never a fragment of another word', () => {
    expect(isBlocked({ company: 'Banana Tech', title: 'Dev', description: '' }, { blockedCompanies: ['ana'], blockedTerms: [] })).toBeNull();
    expect(isBlocked({ company: 'Acme', title: 'Dev', description: 'Vaga de estagiario' }, { blockedCompanies: [], blockedTerms: ['estagio'] })).toBeNull();
    expect(isBlocked({ company: 'Ana Tech', title: 'Dev', description: '' }, { blockedCompanies: ['ana'], blockedTerms: [] })).toBe('ana');
    expect(isBlocked({ company: 'Acme', title: 'Dev', description: 'Vaga de ESTÁGIO, remoto.' }, { blockedCompanies: [], blockedTerms: ['estagio'] })).toBe('estagio');
  });
  it('opens at 08:00 and closes at 21:00 in the configured time zone', () => {
    const at = (hhmm: string) => Date.parse(`2026-11-12T${hhmm}:00-03:00`);
    const w = { start: '08:00', end: '21:00' };
    expect(withinWindow(at('07:59'), w, 'America/Sao_Paulo')).toBe(false);
    expect(withinWindow(at('08:00'), w, 'America/Sao_Paulo')).toBe(true);
    expect(withinWindow(at('20:59'), w, 'America/Sao_Paulo')).toBe(true);
    expect(withinWindow(at('21:00'), w, 'America/Sao_Paulo')).toBe(false);
  });
  it('subtracts today from the caps and bounds by the total', () => {
    expect(capsLeft({ forms: { linkedin: 9, greenhouse: 0, lever: 0, fake: 0 }, views: { linkedin: 30, greenhouse: 0, lever: 0, fake: 0 }, total: 29 },
      APPLY_DEFAULTS.dailyCaps, 'linkedin')).toEqual({ forms: 1, views: 0, total: 1 });
  });
  it('leaves views unbounded outside LinkedIn and never goes negative', () => {
    const counts = { forms: { linkedin: 0, greenhouse: 20, lever: 0, fake: 0 }, views: { linkedin: 0, greenhouse: 0, lever: 0, fake: 0 }, total: 31 };
    expect(capsLeft(counts, APPLY_DEFAULTS.dailyCaps, 'greenhouse')).toEqual({ forms: 0, views: Infinity, total: 0 });
  });
  it('spaces LinkedIn forms by 3 to 8 minutes and views by 1 to 3', () => {
    expect(nextAllowedAt('linkedin', { formAt: 1_000_000, viewAt: null }, 'form', () => 0)).toBe(1_000_000 + 180_000);
    expect(nextAllowedAt('linkedin', { formAt: 1_000_000, viewAt: null }, 'form', () => 0.999999)).toBeCloseTo(1_000_000 + 480_000, -3);
    expect(nextAllowedAt('linkedin', { formAt: null, viewAt: 1_000_000 }, 'view', () => 0)).toBe(1_000_000 + 60_000);
    expect(nextAllowedAt('fake', { formAt: 1_000_000, viewAt: null }, 'form', () => 0.5)).toBe(1_000_000);
  });
  it('allows right away when there is no previous action', () => {
    expect(nextAllowedAt('linkedin', { formAt: null, viewAt: null }, 'form', () => 0.5)).toBe(0);
  });
  it('decides the gate', () => {
    expect(decideGate({ blockedBy: 'acme', gate: null, minScore: 70, manual: true })).toMatchObject({ pass: false, reason: 'blocked' });
    expect(decideGate({ blockedBy: null, gate: { score: 69, eligible: true, ineligibleReason: '' }, minScore: 70, manual: false })).toMatchObject({ pass: false, reason: 'below_min_score' });
    expect(decideGate({ blockedBy: null, gate: { score: 90, eligible: false, ineligibleReason: 'exige residência nos EUA' }, minScore: 70, manual: false }))
      .toEqual({ pass: false, reason: 'not_eligible', detail: 'exige residência nos EUA' });
    expect(decideGate({ blockedBy: null, gate: null, minScore: 70, manual: true })).toEqual({ pass: true, score: null });
  });
  it('manual requests only respect the block list; automatic ones need a passing gate', () => {
    expect(decideGate({ blockedBy: null, gate: { score: 10, eligible: false, ineligibleReason: 'x' }, minScore: 70, manual: true })).toEqual({ pass: true, score: 10 });
    expect(decideGate({ blockedBy: null, gate: { score: 70, eligible: true, ineligibleReason: '' }, minScore: 70, manual: false })).toEqual({ pass: true, score: 70 });
    expect(decideGate({ blockedBy: null, gate: null, minScore: 70, manual: false })).toMatchObject({ pass: false });
  });
});
