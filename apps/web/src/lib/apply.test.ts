import { describe, expect, it } from 'vitest';
import { APPLICATION_FILTERS, APPLICATION_STATUSES, NUMBER_FORMAT_PROBLEM, applicationFilterOf, type ApplyAnswerDto, NEEDS_HUMAN_REASONS, SKIP_REASONS, type AnswerSource, type ApplicationListItemDto, type ApplicationStatus, type ApplyStatusDto, type PendingQuestion, type Question } from '@kv/shared';
import {
  AI_ANSWER_LABELS, FILTER_LABELS, PENDING_KIND_LABELS, ANSWER_SOURCE_LABELS, STATUS_LABELS, applyErrorMessage, applyPollMs, cardBadge,
  ANSWER_LIMITS, EMPTY_NEW_ANSWER, accountFeedback, answerField, answerInput, answerProblem, answerToStore, booleanAnswer, booleanChoice, counterVisible,
  countryLabel, kindHint, newAnswerInput, numberProblem, saveStateLabel, scopeLabel, splitAnswers, usedLabel, validateNewAnswer, reasonText, toPendingAnswersBody, validatePendingDrafts, decideCommit, queueSignature, createKeyedQueue, type AccountAction, type AccountMutationView, type PendingDraft,
} from './apply';

const idle: ApplyStatusDto = {
  available: true, unavailableReason: null, enabled: true, withinWindow: true, worker: null, sites: [], totalToday: 0, totalCap: 30,
  queued: 0, needsHuman: 0, running: 0, waiting: null,
};

describe('filters', () => {
  it('labels every shared filter, and "not sent" (from the shared mapping) holds failed and cancelled', () => {
    expect(Object.keys(FILTER_LABELS)).toEqual([...APPLICATION_FILTERS]);
    expect(['failed', 'cancelled', 'skipped'].map((s) => applicationFilterOf(s as ApplicationStatus))).toEqual(['skipped', 'skipped', 'skipped']);
    expect(FILTER_LABELS).toEqual({
      active: 'Em andamento', needs_human: 'Precisam de você', rehearsals: 'Ensaios prontos', submitted: 'Enviadas', skipped: 'Não enviadas',
    });
  });
  it('labels every status', () => {
    for (const s of APPLICATION_STATUSES) expect(STATUS_LABELS[s].length).toBeGreaterThan(0);
  });
});

describe('cardBadge', () => {
  const job = (appliedBy: 'ia' | 'humano' | null, needsHuman: boolean, applicationStatus: ApplicationStatus | null) =>
    ({ appliedBy, needsHuman, applicationStatus });
  it('chooses the card badge', () => {
    expect(cardBadge(job(null, true, 'needs_human'))).toBe('needs_human');
    expect(cardBadge(job(null, false, 'filling'))).toBe('applying');
    expect(cardBadge(job(null, false, 'dry_run_ready'))).toBe('rehearsal');
    expect(cardBadge(job('ia', false, 'submitted'))).toBe('applied_by_ai');
    expect(cardBadge(job('humano', false, null))).toBeNull();
  });
  it('lets the job mark win, and leaves queued without a badge', () => {
    expect(cardBadge(job('ia', true, 'submitted'))).toBe('needs_human');
    expect(cardBadge(job(null, true, null))).toBe('needs_human');
    expect(cardBadge(job(null, false, 'queued'))).toBeNull();
    for (const s of ['preparing', 'waiting_human', 'submitting'] as const) expect(cardBadge(job(null, false, s))).toBe('applying');
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

describe('queueSignature', () => {
  it('changes whenever the queue counts or the live wait change, so the lists are reread at once', () => {
    // A lista e a candidatura da vaga são relidas no ritmo do estado: quando a última candidatura para numa pergunta,
    // o estado passa a 15 s e a lista podia ficar 15 s dizendo "Em andamento" com o contador já em "Precisam de você".
    expect(queueSignature(undefined)).toBeNull();
    const base = queueSignature(idle);
    expect(queueSignature({ ...idle })).toBe(base);
    for (const changed of [
      { ...idle, queued: 1 }, { ...idle, running: 1 }, { ...idle, needsHuman: 1 },
      { ...idle, waiting: { applicationId: 1, jobId: 1, gate: 'captcha' as const } },
    ]) expect(queueSignature(changed)).not.toBe(base);
    expect(queueSignature({ ...idle, totalToday: 3 })).toBe(base); // só o que muda as listas
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
    expect(toPendingAnswersBody([pend(q('a')), pend(q('b')), pend(q('c'))], [
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

describe('accountFeedback', () => {
  const idleM: AccountMutationView = { isPending: false, isSuccess: false, isError: false, error: null, variables: undefined };
  const states = (over: Partial<Record<AccountAction, Partial<AccountMutationView>>> = {}) => ({
    open: { ...idleM, ...over.open }, check: { ...idleM, ...over.check }, logout: { ...idleM, ...over.logout },
  });

  it('shows nothing before a click', () => {
    expect(accountFeedback(null, 'linkedin', states())).toEqual({ kind: 'idle' });
  });

  it('shows only the last clicked action: a later success hides an earlier error', () => {
    const s = states({
      open: { isError: true, error: { message: 'falhou' }, variables: 'linkedin' },
      check: { isSuccess: true, variables: 'linkedin' },
    });
    expect(accountFeedback('check', 'linkedin', s)).toEqual({ kind: 'sent' });
    expect(accountFeedback('open', 'linkedin', s)).toEqual({ kind: 'error', message: 'falhou' });
  });

  it('shows pending while the last action runs, and ignores a mutation used for another site', () => {
    expect(accountFeedback('logout', 'linkedin', states({ logout: { isPending: true, variables: 'linkedin' } }))).toEqual({ kind: 'pending' });
    expect(accountFeedback('check', 'linkedin', states({ check: { isSuccess: true, variables: 'greenhouse' } }))).toEqual({ kind: 'idle' });
  });
});

const row = (over: Partial<ApplyAnswerDto>): ApplyAnswerDto => ({
  id: 1, question: 'Pergunta?', key: null, answer: '', kind: 'text', scope: 'always', scopeValue: null, country: null,
  aliases: [], usedCount: 0, updatedAt: 1, ...over,
});

describe('answer bank rows', () => {
  it('splits the common questions (with a key) from the learned ones, keeping the API order', () => {
    const rows = [row({ id: 1, key: 'a' }), row({ id: 2 }), row({ id: 3, key: 'b' }), row({ id: 4 })];
    const { common, learned } = splitAnswers(rows);
    expect(common.map((r) => r.id)).toEqual([1, 3]);
    expect(learned.map((r) => r.id)).toEqual([2, 4]);
  });
  it('picks the field by kind: choice is text, one option per line', () => {
    expect(['text', 'number', 'boolean', 'choice'].map((k) => answerField(k as ApplyAnswerDto['kind']))).toEqual(['text', 'number', 'boolean', 'text']);
  });
  it('reads and writes a boolean as Sim, Não or nothing', () => {
    expect(['Sim', 'Não', '', 'talvez'].map(booleanChoice)).toEqual(['yes', 'no', 'none', 'none']);
    expect((['yes', 'no', 'none'] as const).map(booleanAnswer)).toEqual(['Sim', 'Não', '']);
  });
  it('refuses a number with a thousands separator or letters, accepts a plain, negative or decimal one', () => {
    for (const ok of ['', '  ', '20000', '8000,50', '8000.5', '0', '-5']) expect(numberProblem(ok)).toBeNull();
    for (const bad of ['20.000', '20,000', '1.234,56', '0.125', '8000.500', 'abc', '12a', '1,2,3', '1,2345']) expect(numberProblem(bad)).toBe(NUMBER_FORMAT_PROBLEM);
    expect(answerProblem('text', '20.000')).toBeNull();
    expect(answerProblem('number', '20.000')).toBe(NUMBER_FORMAT_PROBLEM);
  });
  it('stores what was typed in the shape the bank expects', () => {
    expect(answerToStore('number', ' 8000,5 ')).toBe('8000.5');
    expect(answerToStore('choice', ' A \n\n B, C \r\n')).toBe('A\nB, C');
    expect(answerToStore('text', '  Imediato \n')).toBe('Imediato');
    expect(answerToStore('boolean', 'Sim')).toBe('Sim');
  });
  it('labels the save state like the job notes', () => {
    expect(saveStateLabel('saving', true)).toBe('Salvando…');
    expect(saveStateLabel('error', true)).toBe('Não salvo');
    expect(saveStateLabel('saved', false)).toBe('Salvo');
    expect(saveStateLabel('saved', true)).toBe('');
    expect(saveStateLabel('idle', false)).toBe('');
  });
  it('shows the scope, country and use in words', () => {
    expect(scopeLabel('always', null)).toBe('sempre');
    expect(scopeLabel('company', 'Acme Fictícia')).toBe('só na empresa Acme Fictícia');
    expect(scopeLabel('job', 'x')).toBe('só nesta vaga');
    expect(countryLabel('BR')).toBe('vagas no Brasil');
    expect(countryLabel('US')).toBe('vagas em US');
    expect(countryLabel(null)).toBeNull();
    expect([0, 1, 3].map(usedLabel)).toEqual(['ainda não usada', 'usada 1 vez', 'usada 3 vezes']);
  });
  it('hints at the expected shape of a number or a choice', () => {
    expect(kindHint('number')).toMatch(/milhar/);
    expect(kindHint('choice')).toMatch(/linha/);
    expect([kindHint('text'), kindHint('boolean')]).toEqual(['', '']);
  });
  it('shows the counter only near the limit', () => {
    expect(counterVisible(1799, ANSWER_LIMITS.answer)).toBe(false);
    expect(counterVisible(1800, ANSWER_LIMITS.answer)).toBe(true);
  });
  it('keeps everything but the answer when a row is saved', () => {
    const r = row({ question: 'Q?', kind: 'number', scope: 'company', scopeValue: 'Acme', country: 'BR', key: 'k' });
    expect(answerInput(r, '5')).toEqual({ question: 'Q?', answer: '5', kind: 'number', scope: 'company', scopeValue: 'Acme', country: 'BR' });
  });
  it('validates and builds a new answer', () => {
    expect(validateNewAnswer(EMPTY_NEW_ANSWER)).toEqual({ question: 'Escreva a pergunta.', answer: 'Escreva a resposta.' });
    const draft = { ...EMPTY_NEW_ANSWER, question: ' Visto? ', answer: ' Não ', kind: 'boolean' as const, scope: 'company' as const, company: ' ', brazilOnly: true };
    expect(validateNewAnswer(draft)).toEqual({ company: 'Escreva o nome da empresa.' });
    expect(newAnswerInput({ ...draft, company: ' Acme ' })).toEqual({
      question: 'Visto?', answer: 'Não', kind: 'boolean', scope: 'company', scopeValue: 'Acme', country: 'BR',
    });
    expect(validateNewAnswer({ ...EMPTY_NEW_ANSWER, question: 'x', answer: '20.000', kind: 'number' }).answer).toBe(NUMBER_FORMAT_PROBLEM);
    expect(NUMBER_FORMAT_PROBLEM).toBe('Use só dígitos, com no máximo duas casas decimais e sem separador de milhar (ex.: 20000 ou 1234,56).');
    expect(newAnswerInput({ ...EMPTY_NEW_ANSWER, question: 'x', answer: 'y' })).toMatchObject({ scope: 'always', scopeValue: null, country: null });
  });
});

describe('decideCommit', () => {
  it('sends nothing when nothing was typed, even if the stored text is not in canonical form', () => {
    expect(decideCommit('number', null, '8000.50 ')).toEqual({ action: 'nothing' });
    expect(decideCommit('number', null, '20.000')).toEqual({ action: 'nothing' });
    expect(decideCommit('choice', null, 'A\n\nB')).toEqual({ action: 'nothing' });
  });
  it('refuses a bad number, skips an unchanged one and sends a changed one in stored form', () => {
    expect(decideCommit('number', '20.000', '5')).toEqual({ action: 'invalid', problem: NUMBER_FORMAT_PROBLEM });
    expect(decideCommit('number', ' 5 ', '5')).toEqual({ action: 'unchanged' });
    expect(decideCommit('number', '8000,5', '5')).toEqual({ action: 'send', stored: '8000.5' });
    expect(decideCommit('text', ' oi ', '')).toEqual({ action: 'send', stored: 'oi' });
  });
});

describe('createKeyedQueue', () => {
  it('runs the tasks of one key one after another, and other keys at the same time', async () => {
    const run = createKeyedQueue<number>();
    const log: string[] = [];
    const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
    const a1 = gate();
    const first = run(1, async () => { log.push('a1 start'); await a1.p; log.push('a1 end'); return 'a1'; });
    const second = run(1, async () => { log.push('a2 start'); return 'a2'; });
    const other = run(2, async () => { log.push('b start'); return 'b'; });
    await other;
    expect(log).toEqual(['a1 start', 'b start']);
    a1.open();
    expect(await Promise.all([first, second])).toEqual(['a1', 'a2']);
    expect(log).toEqual(['a1 start', 'b start', 'a1 end', 'a2 start']);
  });
  it('keeps going after a task fails', async () => {
    const run = createKeyedQueue<number>();
    const failed = run(1, async () => { throw new Error('boom'); });
    const next = run(1, async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ok');
  });
});
