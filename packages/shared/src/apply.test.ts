import { describe, expect, it } from 'vitest';
import {
  ACTIVE_APPLICATION_STATUSES, APPLY_DEFAULTS, APPLY_TIMING, applyAvailability, isActiveApplication,
  normalizeQuestionText, PendingAnswersBodySchema, ApplyAnswerInputSchema, type ApplicationStatus,
} from './index';

describe('apply constants', () => {
  it('normalizes question text for exact matching', () => {
    expect(normalizeQuestionText('  Qual a sua PRETENSÃO salarial?  ')).toBe('qual a sua pretensao salarial');
    expect(normalizeQuestionText('Years of experience (React.js)')).toBe('years of experience react js');
  });
  it('says which statuses are active', () => {
    expect(ACTIVE_APPLICATION_STATUSES.every(isActiveApplication)).toBe(true);
    expect(['submitted', 'dry_run_ready', 'needs_human', 'skipped', 'failed', 'cancelled'].some((s) => isActiveApplication(s as ApplicationStatus))).toBe(false);
  });
  it('is available only on a local host', () => {
    expect(applyAvailability({}).available).toBe(true);
    expect(applyAvailability({ HOST: '127.0.0.1' }).available).toBe(true);
    expect(applyAvailability({ HOST: 'localhost' }).available).toBe(true);
    expect(applyAvailability({ HOST: '::1' }).available).toBe(true);
    expect(applyAvailability({ HOST: '0.0.0.0' })).toEqual({ available: false, reason: expect.stringContaining('local') });
  });
  it('keeps the defaults the spec fixes', () => {
    expect(APPLY_DEFAULTS.minScore).toBe(70);
    expect(APPLY_DEFAULTS.dailyCaps).toMatchObject({ linkedin: 10, greenhouse: 15, lever: 15, total: 30, linkedinViews: 30 });
    expect(APPLY_TIMING.humanWaitMs).toBe(600_000);
  });
});

describe('apply schemas', () => {
  it('rejects extra keys and bad scopes in the pending answers body', () => {
    expect(PendingAnswersBodySchema.safeParse({ answers: [{ questionId: 'q1', value: 'x', scope: 'always', confirmMatch: false }] }).success).toBe(true);
    expect(PendingAnswersBodySchema.safeParse({ answers: [{ questionId: 'q1', value: 'x', scope: 'forever', confirmMatch: false }] }).success).toBe(false);
    expect(PendingAnswersBodySchema.safeParse({ answers: [], extra: 1 }).success).toBe(false);
  });
  it('caps the pending answers at 60 items', () => {
    const item = { questionId: 'q', value: null, scope: 'job', confirmMatch: true };
    expect(PendingAnswersBodySchema.safeParse({ answers: Array(60).fill(item) }).success).toBe(true);
    expect(PendingAnswersBodySchema.safeParse({ answers: Array(61).fill(item) }).success).toBe(false);
  });
  it('is strict about the saved answer input', () => {
    const ok = { question: 'q', answer: 'a', kind: 'text', scope: 'always', scopeValue: null, country: null };
    expect(ApplyAnswerInputSchema.safeParse(ok).success).toBe(true);
    expect(ApplyAnswerInputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(ApplyAnswerInputSchema.safeParse({ ...ok, kind: 'longtext' }).success).toBe(false);
  });
});
