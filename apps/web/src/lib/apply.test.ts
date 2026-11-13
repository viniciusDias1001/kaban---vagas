import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUSES, NEEDS_HUMAN_REASONS, SKIP_REASONS, type AnswerSource, type ApplicationListItemDto, type ApplicationStatus, type ApplyStatusDto, type PendingQuestion, type Question } from '@kv/shared';
import {
  AI_ANSWER_LABELS, FILTER_LABELS, PENDING_KIND_LABELS, type ApplicationFilter, ANSWER_SOURCE_LABELS, STATUS_LABELS, applyErrorMessage, applyPollMs, cardBadge, filterApplications,
  filterCounts, reasonText, toPendingAnswersBody, validatePendingDrafts, type PendingDraft,
} from './apply';

const item = (id: number, status: ApplicationStatus): ApplicationListItemDto => ({
  id, jobId: id, jobTitle: 'Dev', company: 'Acme', site: 'fake', status, reason: null, detail: null, mode: 'dry_run',
  gateScore: 80, pendingCount: 0, createdAt: 1, submittedAt: null,
});
const items = [
  item(1, 'queued'), item(2, 'filling'), item(3, 'needs_human'), item(4, 'dry_run_ready'),
  item(5, 'submitted'), item(6, 'submitted'), item(7, 'submitted'), item(8, 'skipped'), item(9, 'skipped'),
];
const idle: ApplyStatusDto = {
  available: true, unavailableReason: null, enabled: true, withinWindow: true, sites: [], totalToday: 0, totalCap: 30,
  queued: 0, needsHuman: 0, running: 0, waiting: null,
};

describe('filters', () => {
  it('groups applications by filter', () => {
    expect(filterCounts(items)).toEqual({ active: 2, needs_human: 1, rehearsals: 1, submitted: 3, skipped: 2 });
    expect(filterApplications(items, 'needs_human').map((i) => i.status)).toEqual(['needs_human']);
    expect(filterApplications(items, 'active').map((i) => i.id)).toEqual([1, 2]);
  });
  it('puts every status in exactly one filter, so "not sent" includes failed and cancelled', () => {
    const filters = Object.keys(FILTER_LABELS) as ApplicationFilter[];
    for (const status of APPLICATION_STATUSES) {
      const hits = filters.filter((f) => filterApplications([item(1, status)], f).length === 1);
      expect(hits, status).toHaveLength(1);
    }
    expect(filterApplications([item(1, 'failed'), item(2, 'cancelled'), item(3, 'skipped')], 'skipped')).toHaveLength(3);
    expect(FILTER_LABELS).toEqual({
      active: 'Em andamento', needs_human: 'Precisam de você', rehearsals: 'Ensaios prontos', submitted: 'Enviadas', skipped: 'Não enviadas',
    });
  });
  it('labels every status', () => {
    for (const s of APPLICATION_STATUSES) expect(STATUS_LABELS[s].length).toBeGreaterThan(0);
  });
});

describe('cardBadge', () => {
  it('chooses the card badge', () => {
    expect(cardBadge({ appliedBy: null, needsHuman: true }, 'needs_human')).toBe('needs_human');
    expect(cardBadge({ appliedBy: null, needsHuman: false }, 'filling')).toBe('applying');
    expect(cardBadge({ appliedBy: null, needsHuman: false }, 'dry_run_ready')).toBe('rehearsal');
    expect(cardBadge({ appliedBy: 'ia', needsHuman: false }, 'submitted')).toBe('applied_by_ai');
    expect(cardBadge({ appliedBy: 'humano', needsHuman: false }, undefined)).toBeNull();
  });
  it('lets the job mark win, and leaves queued without a badge', () => {
    expect(cardBadge({ appliedBy: 'ia', needsHuman: true }, 'submitted')).toBe('needs_human');
    expect(cardBadge({ appliedBy: null, needsHuman: true }, undefined)).toBe('needs_human');
    expect(cardBadge({ appliedBy: null, needsHuman: false }, 'queued')).toBeNull();
    for (const s of ['preparing', 'waiting_human', 'submitting'] as const) expect(cardBadge({ appliedBy: null, needsHuman: false }, s)).toBe('applying');
  });
});

describe('texts', () => {
  it('explains every reason in Portuguese', () => {
    for (const reason of [...NEEDS_HUMAN_REASONS, ...SKIP_REASONS]) expect(reasonText(reason, null).length).toBeGreaterThan(10);
    expect(reasonText('not_eligible', 'exige residência nos EUA')).toContain('exige residência nos EUA');
    expect(reasonText(null, 'x')).toBe('');
  });
  it('labels every answer source and AI answer mode', () => {
    const sources: AnswerSource[] = ['rule', 'bank', 'profile', 'written', 'blank'];
    for (const s of sources) expect(ANSWER_SOURCE_LABELS[s]).toBeTruthy();
    expect(Object.keys(AI_ANSWER_LABELS)).toEqual(['off', 'review', 'auto']);
    expect(AI_ANSWER_LABELS.review.title).toBe('Com a sua aprovação');
    expect(PENDING_KIND_LABELS).toEqual({ unanswered: 'sem resposta', confirm_match: 'confirmar resposta salva', confirm_proposal: 'confirmar proposta da IA' });
  });
  it('turns known 409 codes into messages and falls back to the general text', () => {
    for (const code of ['in_progress', 'confirm_submission', 'not_rehearsal', 'sent', 'not_pending', 'already_exists']) {
      expect(applyErrorMessage(409, JSON.stringify({ error: code }))).not.toMatch(/erro 409/);
    }
    expect(applyErrorMessage(409, JSON.stringify({ error: 'in_progress' }))).toContain('em andamento');
    expect(applyErrorMessage(409, JSON.stringify({ error: 'weird', message: 'algo' }))).toBe('Algo');
    expect(applyErrorMessage(500, '<html>')).toContain('erro 500');
  });
});

describe('applyPollMs', () => {
  it('polls faster while something is running or waiting', () => {
    expect(applyPollMs({ ...idle, queued: 1 })).toBe(2_000);
    expect(applyPollMs({ ...idle, waiting: { applicationId: 1, jobId: 1, gate: 'captcha' } })).toBe(2_000);
    expect(applyPollMs(idle)).toBe(15_000);
    expect(applyPollMs(undefined)).toBe(15_000);
  });

  it('polls fast while an application is running', () => {
    expect(applyPollMs({ ...idle, running: 1 })).toBe(2_000);
  });
});

describe('pending answers', () => {
  const q = (id: string, over: Partial<Question> = {}): Question => ({
    id, label: id, help: '', kind: 'text', options: [], required: true, maxLength: null, ...over,
  });
  const pend = (question: Question, kind: PendingQuestion['kind'] = 'unanswered'): PendingQuestion => ({
    question, category: 'unknown', kind,
    proposal: kind === 'unanswered' ? null : { bankAnswerId: null, bankQuestion: null, bankAnswer: null, value: 'Sim', source: 'profile', basis: [] },
  });
  const draft = (questionId: string, over: Partial<PendingDraft> = {}): PendingDraft => ({ questionId, accept: false, value: null, scope: 'always', ...over });

  it('builds the body, dropping blank optional drafts and sending accept as confirmMatch', () => {
    expect(toPendingAnswersBody([
      draft('a', { value: 'Sim' }), draft('b', { accept: true, value: 'Yes', scope: 'job' }), draft('c', { value: '  ' }),
    ])).toEqual({
      answers: [
        { questionId: 'a', value: 'Sim', scope: 'always', confirmMatch: false },
        { questionId: 'b', value: 'Yes', scope: 'job', confirmMatch: true },
      ],
    });
  });

  it('requires an answer or an accept for required questions, but not for optional ones', () => {
    const pending = [pend(q('a')), pend(q('b', { required: false })), pend(q('c'), 'confirm_match')];
    expect(Object.keys(validatePendingDrafts(pending, [draft('c', { accept: true, value: 'Sim' })]))).toEqual(['a']);
    expect(validatePendingDrafts(pending, [draft('a', { value: 'x' }), draft('c', { accept: true })])).toEqual({});
  });

  it('refuses accepting an unanswered question, an option outside the list and an invalid number', () => {
    const pending = [
      pend(q('a')), pend(q('s', { kind: 'select', options: ['Sim', 'Não'] })), pend(q('m', { kind: 'multiselect', options: ['x', 'y'] })), pend(q('n', { kind: 'number' })),
    ];
    const errors = validatePendingDrafts(pending, [
      draft('a', { accept: true }), draft('s', { value: 'Talvez' }), draft('m', { value: ['x', 'z'] }), draft('n', { value: 'abc' }),
    ]);
    expect(Object.keys(errors).sort()).toEqual(['a', 'm', 'n', 's']);
    expect(validatePendingDrafts(pending, [
      draft('a', { value: 'ok' }), draft('s', { value: 'Sim' }), draft('m', { value: ['x'] }), draft('n', { value: '3,5' }),
    ])).toEqual({});
  });
});
