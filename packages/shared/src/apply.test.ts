import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ACTIVE_APPLICATION_STATUSES, APPLY_DEFAULTS, APPLY_TIMING, applyAvailability, isActiveApplication,
  normalizeQuestionText, bankBoolean, bankList, bankText, SHOT_KINDS, PendingAnswersBodySchema, ApplyAnswerInputSchema, type AnswerValue, type ApplicationStatus,
  type PendingQuestion, COLUMNS, COLUMN_LABELS, isAppliedOrLater, type CannotApplyReason, type JobApplicationDto,
  APPLICATION_FILTERS, APPLICATION_FILTER_STATUSES, APPLICATION_STATUSES, applicationFilterOf, type ApplicationFilter,
  NUMBER_FORMAT_PROBLEM, parseNumberAnswer,
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
  it('a pending question carries a model proposal with its source and basis', () => {
    const question = { id: 'q1', label: 'Anos de React?', help: '', kind: 'text' as const, options: [], required: true, maxLength: null };
    const proposal: PendingQuestion = {
      question, category: 'profile_fact', kind: 'confirm_proposal',
      proposal: { bankAnswerId: null, bankQuestion: null, bankAnswer: null, value: '5', source: 'profile', basis: ['exp_aaaaaaa1'] },
    };
    const match: PendingQuestion = {
      question, category: 'personal', kind: 'confirm_match',
      proposal: { bankAnswerId: 7, bankQuestion: 'Precisa de visto?', bankAnswer: 'Não', value: 'No', source: 'bank', basis: [] },
    };
    expect(proposal.proposal?.bankAnswerId).toBeNull();
    expectTypeOf(proposal.proposal!.source).toEqualTypeOf<'bank' | 'profile' | 'written'>();
    expectTypeOf(match.kind).toEqualTypeOf<'unanswered' | 'confirm_match' | 'confirm_proposal'>();
    expectTypeOf(match.proposal!.value).toEqualTypeOf<AnswerValue>();
  });
  it('keeps the defaults the spec fixes', () => {
    expect(APPLY_DEFAULTS.minScore).toBe(70);
    expect(APPLY_DEFAULTS.dailyCaps).toMatchObject({ linkedin: 10, greenhouse: 15, lever: 15, total: 30, linkedinViews: 30 });
    expect(APPLY_TIMING.humanWaitMs).toBe(600_000);
  });
});

describe('the number rule', () => {
  it('accepts digits with an optional minus and up to two decimals, and returns them with a dot', () => {
    expect(parseNumberAnswer(' 20000 ')).toBe('20000');
    expect(parseNumberAnswer('1234,56')).toBe('1234.56');
    expect(parseNumberAnswer('8000.5')).toBe('8000.5');
    expect(parseNumberAnswer('-5')).toBe('-5');
    expect(parseNumberAnswer('0')).toBe('0');
    for (const bad of ['', ' ', '20.000', '20,000', '1.234,56', '1,2345', '1e3', '0x10', 'abc', '12a', '1,2,3', '- 5', '5.']) {
      expect(parseNumberAnswer(bad)).toBeNull();
    }
    expect(NUMBER_FORMAT_PROBLEM).toBe('Use só dígitos, com no máximo duas casas decimais e sem separador de milhar (ex.: 20000 ou 1234,56).');
  });
});

describe('application filters', () => {
  it('puts every status in exactly one filter', () => {
    expect(APPLICATION_FILTERS).toEqual(['active', 'needs_human', 'rehearsals', 'submitted', 'skipped']);
    const of = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, applicationFilterOf(s)]));
    expect(of).toEqual({
      queued: 'active', preparing: 'active', filling: 'active', waiting_human: 'active', submitting: 'active',
      needs_human: 'needs_human', dry_run_ready: 'rehearsals', submitted: 'submitted',
      skipped: 'skipped', failed: 'skipped', cancelled: 'skipped',
    });
    for (const f of APPLICATION_FILTERS) {
      expect(APPLICATION_FILTER_STATUSES[f]).toEqual(APPLICATION_STATUSES.filter((s) => applicationFilterOf(s) === f));
    }
    expectTypeOf(applicationFilterOf).returns.toEqualTypeOf<ApplicationFilter>();
  });
});

describe('already applied', () => {
  it('counts Aplicada and every column after it as applied', () => {
    expect(COLUMNS.filter(isAppliedOrLater)).toEqual(['aplicada', 'entrevista', 'oferta', 'perdida', 'arquivada']);
    expect(COLUMNS.indexOf('perdida')).toBe(COLUMNS.indexOf('oferta') + 1);
    expect(COLUMN_LABELS.perdida).toBe('Perdida');
  });
  it('describes the application of a job and why it cannot be applied to', () => {
    const dto: JobApplicationDto = { application: null, site: null, canApply: false, cannotApplyReason: 'unsupported_site' };
    expectTypeOf(dto.cannotApplyReason).toEqualTypeOf<CannotApplyReason | null>();
    expectTypeOf<CannotApplyReason>().toEqualTypeOf<
      'unsupported_site' | 'already_applied' | 'blocked' | 'apply_unavailable' | 'apply_disabled' | 'already_exists'
    >();
  });
});

describe('saved answer encoding', () => {
  it('writes values as text', () => {
    expect(bankText(true)).toBe('Sim');
    expect(bankText(false)).toBe('Não');
    expect(bankText(['A', ' B ', ''])).toBe('A\nB');
    expect(bankText('  x ')).toBe('x');
    expect(bankText(null)).toBe('');
  });
  it('reads yes and no, and nothing else', () => {
    for (const t of ['Sim', 'yes', 'TRUE', 'Verdadeiro', 's', 'Y', '1', ' sim ']) expect(bankBoolean(t)).toBe(true);
    for (const t of ['Não', 'nao', 'No', 'false', 'FALSO', 'n', '0']) expect(bankBoolean(t)).toBe(false);
    for (const t of ['talvez', '', '2', 'sim e não']) expect(bankBoolean(t)).toBeNull();
    expect(bankBoolean(bankText(true))).toBe(true);
    expect(bankBoolean(bankText(false))).toBe(false);
  });
  it('reads a list one option per line', () => {
    expect(bankList('A, B\n\n C \r\nD')).toEqual(['A, B', 'C', 'D']);
    expect(bankList('')).toEqual([]);
    expect(bankList(bankText(['x', 'y']))).toEqual(['x', 'y']);
  });
  it('lists the shot kinds', () => {
    expect(SHOT_KINDS).toEqual(['filled', 'confirmation', 'blocked']);
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
  it('caps the size of what the browser sends', () => {
    const item = (over: object) => ({ answers: [{ questionId: 'q', value: 'x', scope: 'always', confirmMatch: false, ...over }] });
    const pending = (over: object) => PendingAnswersBodySchema.safeParse(item(over)).success;
    expect(pending({ questionId: 'q'.repeat(200) })).toBe(true);
    expect(pending({ questionId: 'q'.repeat(201) })).toBe(false);
    expect(pending({ value: 'x'.repeat(2000) })).toBe(true);
    expect(pending({ value: 'x'.repeat(2001) })).toBe(false);
    expect(pending({ value: Array(50).fill('x'.repeat(300)) })).toBe(true);
    expect(pending({ value: Array(51).fill('x') })).toBe(false);
    expect(pending({ value: ['x'.repeat(301)] })).toBe(false);
    const ok = { question: 'q', answer: 'a', kind: 'text', scope: 'job', scopeValue: 's', country: 'BR' };
    const bank = (over: object) => ApplyAnswerInputSchema.safeParse({ ...ok, ...over }).success;
    expect(bank({ question: '' })).toBe(false);
    expect(bank({ question: 'q'.repeat(501) })).toBe(false);
    expect(bank({ question: 'q'.repeat(500) })).toBe(true);
    expect(bank({ answer: 'a'.repeat(2001) })).toBe(false);
    expect(bank({ scopeValue: 's'.repeat(201) })).toBe(false);
    expect(bank({ country: 'BRA' })).toBe(false);
    expect(bank({ country: null, scopeValue: null })).toBe(true);
  });
});
