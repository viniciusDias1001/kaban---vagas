import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUSES, COLUMNS, NUMBER_FORMAT_PROBLEM,
  type ApplicationDto, type ApplicationListItemDto, type ApplicationStatus, type ApplyStatusDto, type Column, type JobApplicationDto,
  type PendingQuestion, type Question,
} from '@kv/shared';
import {
  APPLIED_BY_OWNER_LABEL, RUNNING_STATUSES, answerToStore, applicationActions, applyErrorMessage, applySectionView, cardBadge,
  fileQuestionText, findListItem, firstNewAnswerError, jobAlreadyApplied, listCutText, liveWaitFor, markAppliedTarget, numberProblem,
  reasonText, rowAnswersText, sendAllPlan, sendAllResultText, statusLabel, toPendingAnswersBody, unavailableNotice, validatePendingDrafts,
  withApplication, type PendingDraft,
} from './apply';

const notApplied = { column: 'selecionadas' as Column, appliedBy: null };
const app = (over: Partial<ApplicationDto> = {}): ApplicationDto => ({
  id: 1, jobId: 9, site: 'fake', status: 'queued', reason: null, detail: null, trigger: 'manual', mode: 'dry_run', gateScore: null,
  resumeLang: null, resumeFileName: null, hasResume: false, answers: [], pendingQuestions: [], confirmation: null, shots: [],
  attempts: 0, createdAt: 1, startedAt: null, submittedAt: null, finishedAt: null, cancelRequested: false, events: [], ...over,
});
const status = (over: Partial<ApplyStatusDto> = {}): ApplyStatusDto => ({
  available: true, unavailableReason: null, enabled: true, withinWindow: true, worker: null, sites: [], totalToday: 0, totalCap: 30,
  queued: 0, needsHuman: 0, running: 0, waiting: null, ...over,
});
const listItem = (id: number, s: ApplicationStatus = 'dry_run_ready'): ApplicationListItemDto => ({
  id, jobId: id + 100, jobTitle: `Vaga ${id}`, company: 'Acme', site: 'fake', status: s, reason: null, detail: null, mode: 'dry_run',
  gateScore: 80, pendingCount: 0, createdAt: 1, submittedAt: null,
});

describe('K1: a job already applied to is never applied to again', () => {
  it('reads "already applied" from the column (Aplicada or later) or the applied-by mark', () => {
    for (const c of COLUMNS) expect(jobAlreadyApplied({ column: c, appliedBy: null }), c).toBe(['aplicada', 'entrevista', 'oferta', 'arquivada'].includes(c));
    expect(jobAlreadyApplied({ column: 'descobertas', appliedBy: 'humano' })).toBe(true);
    expect(jobAlreadyApplied({ column: 'descobertas', appliedBy: 'ia' })).toBe(true);
  });

  it('offers no retry and no send when the job is already applied to', () => {
    const applied = { column: 'aplicada' as Column, appliedBy: 'humano' as const };
    for (const s of APPLICATION_STATUSES) {
      const a = applicationActions({ status: s, reason: null, cancelRequested: false }, applied);
      expect(a.retry, s).toBe(false);
      expect(a.send, s).toBe(false);
    }
    expect(applicationActions({ status: 'cancelled', reason: null, cancelRequested: false }, notApplied).retry).toBe(true);
    expect(applicationActions({ status: 'dry_run_ready', reason: null, cancelRequested: false }, notApplied).send).toBe(true);
    // A marca vale mesmo com o card fora de Aplicada.
    expect(applicationActions({ status: 'failed', reason: null, cancelRequested: false }, { column: 'descobertas', appliedBy: 'humano' }).retry).toBe(false);
  });

  it('shows the button only when the API says the job can be applied to, and nothing new for an unsupported site', () => {
    const dto = (over: Partial<JobApplicationDto>): JobApplicationDto => ({ application: null, site: 'fake', canApply: false, cannotApplyReason: null, ...over });
    expect(applySectionView(undefined)).toBe('hidden');
    expect(applySectionView(null)).toBe('hidden');
    expect(applySectionView(dto({ canApply: true }))).toBe('offer');
    for (const reason of ['unsupported_site', 'already_applied', 'blocked', 'apply_unavailable', 'apply_disabled', 'already_exists'] as const) {
      expect(applySectionView(dto({ site: null, cannotApplyReason: reason })), reason).toBe('hidden');
    }
    expect(applySectionView(dto({ application: app(), cannotApplyReason: 'already_exists' }))).toBe('application');
  });

  it('reads a skip the owner settled by marking the job applied as "Aplicada por você", with its explanation', () => {
    expect(APPLIED_BY_OWNER_LABEL).toBe('Aplicada por você');
    expect(statusLabel('skipped', 'already_applied')).toBe('Aplicada por você');
    expect(statusLabel('skipped', 'blocked')).toBe('Pulada');
    expect(statusLabel('cancelled', null)).toBe('Cancelada');
    expect(reasonText('already_applied', null)).toMatch(/por conta própria/);
  });

  it('"Já apliquei por conta própria" moves a card before Aplicada there, and re-sends the column of a card already there', () => {
    expect(markAppliedTarget('selecionadas')).toEqual({ column: 'aplicada', sameColumn: false });
    expect(markAppliedTarget('descobertas')).toEqual({ column: 'aplicada', sameColumn: false });
    expect(markAppliedTarget('aplicada')).toEqual({ column: 'aplicada', sameColumn: true });
    expect(markAppliedTarget('entrevista')).toEqual({ column: 'entrevista', sameColumn: true });
  });

  it('puts an application returned by an action into the job answer, which no longer offers "Aplicar com IA"', () => {
    const a = app({ status: 'needs_human' });
    expect(withApplication({ application: null, site: 'fake', canApply: true, cannotApplyReason: null }, a))
      .toEqual({ application: a, site: 'fake', canApply: false, cannotApplyReason: 'already_exists' });
    expect(withApplication(undefined, a)).toEqual({ application: a, site: a.site, canApply: false, cannotApplyReason: 'already_exists' });
  });

  it('has a pt-BR message for the already_applied refusal', () => {
    expect(applyErrorMessage(409, JSON.stringify({ error: 'already_applied', message: 'x' }))).toMatch(/já se candidatou/);
  });
});

describe('K4: lists, counts and send-all', () => {
  it('says when a filter has more rows than the page shows', () => {
    expect(listCutText(200, 200)).toBeNull();
    expect(listCutText(12, 12)).toBeNull();
    expect(listCutText(200, 345)).toBe('Mostrando as 200 mais recentes de 345.');
  });

  it('sends the ids of the rehearsals the dialog counts, and says how many it cannot show', () => {
    const rows = [listItem(1), listItem(2), listItem(3, 'queued')];
    expect(sendAllPlan(rows, 2)).toEqual({ ids: [1, 2], hidden: 0 });
    expect(sendAllPlan(rows, 250)).toEqual({ ids: [1, 2], hidden: 248 });
    expect(sendAllPlan(undefined, 3)).toEqual({ ids: [], hidden: 3 });
  });

  it('reports the rehearsals the server did not send', () => {
    expect(sendAllResultText({ queued: 3, skipped: 0 })).toBeNull();
    expect(sendAllResultText({ queued: 2, skipped: 1 })).toBe('2 candidaturas foram para a fila de envio. 1 não foi enviada porque deixou de ser um ensaio pronto ou a vaga já foi aplicada.');
    expect(sendAllResultText({ queued: 1, skipped: 2 })).toBe('1 candidatura foi para a fila de envio. 2 não foram enviadas porque deixaram de ser ensaios prontos ou a vaga já foi aplicada.');
    expect(sendAllResultText({ queued: 0, skipped: 1 })).toBe('Nenhuma candidatura foi enviada. 1 não foi enviada porque deixou de ser um ensaio pronto ou a vaga já foi aplicada.');
  });

  it('finds a row in any cached filter list', () => {
    const lists = [undefined, { items: [listItem(1)], counts: {} }, { items: [listItem(2, 'waiting_human')], counts: {} }];
    expect(findListItem(lists, 2)?.jobTitle).toBe('Vaga 2');
    expect(findListItem(lists, 9)).toBeUndefined();
  });

  it('takes the board badge from the job own application status', () => {
    expect(cardBadge({ appliedBy: null, needsHuman: false, applicationStatus: 'filling' })).toBe('applying');
    expect(cardBadge({ appliedBy: null, needsHuman: false, applicationStatus: 'dry_run_ready' })).toBe('rehearsal');
    expect(cardBadge({ appliedBy: null, needsHuman: false, applicationStatus: null })).toBeNull();
    expect(cardBadge({ appliedBy: null, needsHuman: true, applicationStatus: null })).toBe('needs_human');
  });
});

describe('K3: one number rule', () => {
  it('uses the shared rule and its one message', () => {
    for (const ok of ['', '  ', '20000', '8000,50', '8000.5', '-5', '0']) expect(numberProblem(ok), ok).toBeNull();
    for (const bad of ['20.000', '1,2345', '1e3', '0x10', 'abc', '1.234,56']) expect(numberProblem(bad), bad).toBe(NUMBER_FORMAT_PROBLEM);
    expect(answerToStore('number', ' 8000,5 ')).toBe('8000.5');
  });

  it('refuses in a pending answer the numbers the server refuses', () => {
    const q: Question = { id: 'n', label: 'Salário', help: '', kind: 'number', options: [], required: true, maxLength: null };
    const pending: PendingQuestion[] = [{ question: q, category: 'unknown', kind: 'unanswered', proposal: null }];
    const draft = (value: string): PendingDraft[] => [{ questionId: 'n', accept: false, value, scope: 'always' }];
    for (const bad of ['20.000', '1e3', '0x10']) expect(validatePendingDrafts(pending, draft(bad)), bad).toEqual({ n: NUMBER_FORMAT_PROBLEM });
    for (const ok of ['20000', '-5', '1234,56']) expect(validatePendingDrafts(pending, draft(ok)), ok).toEqual({});
  });
});

describe('K6: file questions never block the form', () => {
  const q = (id: string, over: Partial<Question> = {}): Question => ({ id, label: id, help: '', kind: 'text', options: [], required: true, maxLength: null, ...over });
  const pend = (question: Question): PendingQuestion => ({ question, category: 'file', kind: 'unanswered', proposal: null });

  it('leaves file questions out of validation and of the request body', () => {
    const pending = [pend(q('cv', { kind: 'file' })), pend(q('carta', { kind: 'file', required: false })), pend(q('a'))];
    const drafts: PendingDraft[] = [
      { questionId: 'cv', accept: false, value: '', scope: 'always' },
      { questionId: 'carta', accept: false, value: 'x', scope: 'always' },
      { questionId: 'a', accept: false, value: 'ok', scope: 'always' },
    ];
    expect(validatePendingDrafts(pending, drafts)).toEqual({});
    expect(toPendingAnswersBody(pending, drafts).answers.map((x) => x.questionId)).toEqual(['a']);
  });

  it('says an optional file question stays blank', () => {
    expect(fileQuestionText(false)).toBe('Pede um arquivo: é opcional e fica em branco.');
    expect(fileQuestionText(true)).toMatch(/direto no site/);
  });
});

describe('K2: the worker says why it cannot run', () => {
  it('names the worker reason and keeps the settings editable for it, and locks them off a local host', () => {
    expect(unavailableNotice(status())).toBeNull();
    const worker = unavailableNotice(status({
      available: false, unavailableReason: 'Navegador não encontrado', worker: { available: false, reason: 'Navegador não encontrado', seenAt: 1 },
    }));
    expect(worker).toEqual({ title: 'O worker não consegue se candidatar agora', reason: 'Navegador não encontrado', lockSettings: false });
    const host = unavailableNotice(status({ available: false, unavailableReason: 'Só com HOST local.' }));
    expect(host).toEqual({ title: 'Indisponível neste endereço', reason: 'Só com HOST local.', lockSettings: true });
  });

  it('lets the server message through for the codes whose detail matters', () => {
    expect(applyErrorMessage(409, JSON.stringify({ error: 'apply_unavailable', message: 'Navegador não encontrado em C:\\x' }))).toBe('Navegador não encontrado em C:\\x');
    expect(applyErrorMessage(409, JSON.stringify({ error: 'blocked', message: 'A vaga bate com a sua lista de bloqueio ("Acme").' }))).toContain('Acme');
    expect(applyErrorMessage(409, JSON.stringify({ error: 'confirm_submission', message: 'Confira no site; se já enviou, mova o card.' }))).toBe('Confira no site; se já enviou, mova o card.');
    expect(applyErrorMessage(409, JSON.stringify({ error: 'blocked' }))).toBe('A empresa ou a vaga está na sua lista de bloqueio.');
  });
});

describe('K5 and the drawer details', () => {
  it('shows a pending cancel and disables the button', () => {
    const a = applicationActions({ status: 'filling', reason: null, cancelRequested: true }, notApplied);
    expect(a).toMatchObject({ cancel: true, cancelPending: true });
    expect(applicationActions({ status: 'filling', reason: null, cancelRequested: false }, notApplied).cancelPending).toBe(false);
  });

  it('says what to do in the drawer of the job that has the live wait', () => {
    const waiting = status({ waiting: { applicationId: 1, jobId: 9, gate: 'captcha' } });
    expect(liveWaitFor(waiting, 9)).toBe('Resolva o captcha na janela do navegador das candidaturas.');
    expect(liveWaitFor(waiting, 8)).toBeNull();
    expect(liveWaitFor(undefined, 9)).toBeNull();
  });

  it('says "back in the queue" only when the application really went back to it', () => {
    expect(rowAnswersText(app({ status: 'queued' }))).toMatch(/voltou para a fila/);
    expect(rowAnswersText(app({ status: 'filling' }))).toMatch(/voltou para a fila/);
    expect(rowAnswersText(app({ status: 'cancelled' }))).toBe('Esta candidatura não espera mais respostas. Veja o estado dela no painel da vaga.');
    expect(rowAnswersText(null)).toBe('Esta candidatura não espera mais respostas. Veja o estado dela no painel da vaga.');
  });

  it('finds the first field to focus after a blocked submit of the new answer', () => {
    expect(firstNewAnswerError({})).toBeNull();
    expect(firstNewAnswerError({ answer: 'x', question: 'y' })).toBe('question');
    expect(firstNewAnswerError({ answer: 'x', company: 'y' })).toBe('company');
    expect(firstNewAnswerError({ answer: 'x' })).toBe('answer');
  });

  it('has one definition of the running statuses', () => {
    expect(RUNNING_STATUSES).toEqual(['preparing', 'filling', 'waiting_human', 'submitting']);
  });
});
