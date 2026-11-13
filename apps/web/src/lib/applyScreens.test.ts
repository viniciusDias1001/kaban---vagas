import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUSES, type ApplyStatusDto, type PendingQuestion, type Question } from '@kv/shared';
import {
  SCOPE_LABELS, SHOT_LABELS, answerText, applicationActions, applyErrorMessage, canApplyNow, editPendingDraft, emptyAnswerValue,
  firstFilterWithItems, initialPendingDraft, pendingErrorFor, waitingText,
} from './apply';

const q = (id: string, over: Partial<Question> = {}): Question => ({
  id, label: `Pergunta ${id}`, help: '', kind: 'text', options: [], required: true, maxLength: null, ...over,
});
const pending = (question: Question, kind: PendingQuestion['kind'], over: Partial<NonNullable<PendingQuestion['proposal']>> = {}): PendingQuestion => ({
  question, category: 'unknown', kind,
  proposal: kind === 'unanswered'
    ? null
    : { bankAnswerId: kind === 'confirm_match' ? 7 : null, bankQuestion: null, bankAnswer: null, value: 'Sim', source: kind === 'confirm_match' ? 'bank' : 'profile', basis: [], ...over },
});
const status = (over: Partial<ApplyStatusDto> = {}): ApplyStatusDto => ({
  available: true, unavailableReason: null, enabled: true, withinWindow: true, sites: [], totalToday: 0, totalCap: 30,
  queued: 0, needsHuman: 0, running: 0, waiting: null, ...over,
});

describe('applicationActions', () => {
  it('offers "Enviar de verdade" only for a ready rehearsal', () => {
    for (const s of APPLICATION_STATUSES) expect(applicationActions({ status: s, reason: null }).send, s).toBe(s === 'dry_run_ready');
  });

  it('offers retry for stopped applications, except an unconfirmed submission', () => {
    const retry = APPLICATION_STATUSES.filter((s) => applicationActions({ status: s, reason: null }).retry);
    expect(retry.sort()).toEqual(['cancelled', 'failed', 'needs_human', 'skipped']);
    expect(applicationActions({ status: 'needs_human', reason: 'question' }).retry).toBe(true);
    const unconfirmed = applicationActions({ status: 'needs_human', reason: 'confirm_submission' });
    expect(unconfirmed).toMatchObject({ retry: false, cancel: true, alreadyApplied: true, send: false });
  });

  it('offers cancel for every state that is not final, warning that a running one stops later', () => {
    const cancel = APPLICATION_STATUSES.filter((s) => applicationActions({ status: s, reason: null }).cancel);
    expect(cancel.sort()).toEqual(['dry_run_ready', 'filling', 'needs_human', 'preparing', 'queued', 'submitting', 'waiting_human']);
    expect(applicationActions({ status: 'filling', reason: null }).cancelLater).toBe(true);
    expect(applicationActions({ status: 'queued', reason: null }).cancelLater).toBe(false);
    expect(applicationActions({ status: 'submitted', reason: null })).toEqual({
      send: false, retry: false, cancel: false, cancelLater: false, alreadyApplied: false,
    });
  });
});

describe('canApplyNow', () => {
  it('needs no application and the feature available and on', () => {
    expect(canApplyNow(status(), null)).toBe(true);
    expect(canApplyNow(status(), undefined)).toBe(false);
    expect(canApplyNow(undefined, null)).toBe(false);
    expect(canApplyNow(status({ enabled: false }), null)).toBe(false);
    expect(canApplyNow(status({ available: false }), null)).toBe(false);
  });
});

describe('waitingText', () => {
  it('says what to do in the applications browser for each live wait', () => {
    expect(waitingText('captcha')).toBe('Resolva o captcha na janela do navegador das candidaturas');
    expect(waitingText('verification_code')).toContain('código de verificação');
    expect(waitingText('login')).toContain('Entre');
    expect(waitingText('unknown')).toContain('janela do navegador das candidaturas');
  });
});

describe('pending drafts', () => {
  it('starts an unanswered question blank, in the type of the question, scoped to always', () => {
    expect(initialPendingDraft(pending(q('a'), 'unanswered'))).toEqual({ questionId: 'a', accept: false, value: '', scope: 'always' });
    expect(initialPendingDraft(pending(q('m', { kind: 'multiselect', options: ['x'] }), 'unanswered')).value).toEqual([]);
    expect(initialPendingDraft(pending(q('b', { kind: 'boolean' }), 'unanswered')).value).toBeNull();
    expect(emptyAnswerValue(q('n', { kind: 'number' }))).toBe('');
  });

  it('starts a proposal accepted, with the scope its source implies', () => {
    expect(initialPendingDraft(pending(q('c'), 'confirm_match', { value: 'No' }))).toEqual({ questionId: 'c', accept: true, value: 'No', scope: 'always' });
    expect(initialPendingDraft(pending(q('w'), 'confirm_proposal', { source: 'written', value: 'Texto' })).scope).toBe('job');
    expect(initialPendingDraft(pending(q('p'), 'confirm_proposal', { source: 'profile', value: '5' })).scope).toBe('always');
  });

  it('keeps an unchanged proposal as accepted and turns an edit into the owner answer', () => {
    const p = pending(q('w', { kind: 'longtext' }), 'confirm_proposal', { source: 'written', value: 'Gosto de Go.' });
    const start = initialPendingDraft(p);
    expect(editPendingDraft(p, start, 'Gosto de Go e Rust.')).toEqual({ questionId: 'w', accept: false, value: 'Gosto de Go e Rust.', scope: 'job' });
    expect(editPendingDraft(p, start, 'Gosto de Go.')).toEqual(start);
    const multi = pending(q('m', { kind: 'multiselect', options: ['a', 'b'] }), 'confirm_proposal', { value: ['a', 'b'] });
    expect(editPendingDraft(multi, initialPendingDraft(multi), ['b', 'a']).accept).toBe(true);
  });

  it('edits an unanswered question without touching its scope', () => {
    const p = pending(q('a'), 'unanswered');
    expect(editPendingDraft(p, { questionId: 'a', accept: false, value: '', scope: 'company' }, 'x')).toEqual({
      questionId: 'a', accept: false, value: 'x', scope: 'company',
    });
  });
});

describe('pendingErrorFor', () => {
  it('places an API refusal next to the question it names', () => {
    const list = [pending(q('a'), 'unanswered'), pending(q('n', { label: 'Pretensão salarial', kind: 'number' }), 'unanswered')];
    expect(pendingErrorFor(list, 'Pretensão salarial: escreva o número sem separador de milhar (por exemplo 20000)')).toEqual({
      questionId: 'n', text: 'Escreva o número sem separador de milhar (por exemplo 20000)',
    });
    expect(pendingErrorFor(list, 'Esta candidatura não está esperando respostas.')).toBeNull();
  });
});

describe('texts for the application screens', () => {
  it('shows answer values as text', () => {
    expect(answerText(true)).toBe('Sim');
    expect(answerText(false)).toBe('Não');
    expect(answerText(['A', 'B'])).toBe('A, B');
    expect(answerText(null)).toBe('—');
    expect(answerText('  ')).toBe('—');
    expect(answerText('Olá')).toBe('Olá');
  });

  it('labels scopes and photos', () => {
    expect(SCOPE_LABELS).toEqual({ always: 'sempre', company: 'só nesta empresa', job: 'só nesta vaga' });
    expect(Object.keys(SHOT_LABELS).sort()).toEqual(['blocked', 'confirmation', 'filled']);
  });

  it('maps a cancel of a finished application', () => {
    expect(applyErrorMessage(409, JSON.stringify({ error: 'not_cancellable', message: 'x' }))).toBe('Esta candidatura já terminou.');
  });

  it('opens the first filter that has applications, needs-you first', () => {
    expect(firstFilterWithItems({ active: 2, needs_human: 1, rehearsals: 0, submitted: 0, skipped: 0 })).toBe('needs_human');
    expect(firstFilterWithItems({ active: 0, needs_human: 0, rehearsals: 0, submitted: 3, skipped: 0 })).toBe('submitted');
    expect(firstFilterWithItems({ active: 0, needs_human: 0, rehearsals: 0, submitted: 0, skipped: 0 })).toBe('active');
  });
});
