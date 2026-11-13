import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUSES, applyAvailability, type ApplicationDto, type ApplyStatusDto, type Column, type JobApplicationDto, type JobListItemDto,
  type PendingQuestion,
} from '@kv/shared';
import {
  applicationHeadline, applicationReasonText, applySectionNote, applySectionView, markAppliedPlan, queueBlockedReason, repeatsNotice,
  resumeLinkLabel, unavailableNotice,
} from './apply';

const app = (over: Partial<ApplicationDto> = {}): ApplicationDto => ({
  id: 1, jobId: 9, site: 'fake', status: 'queued', reason: null, detail: null, trigger: 'manual', mode: 'dry_run', gateScore: null,
  resumeLang: null, resumeFileName: null, hasResume: false, answers: [], pendingQuestions: [], confirmation: null, shots: [],
  attempts: 0, createdAt: 1, startedAt: null, submittedAt: null, finishedAt: null, cancelRequested: false, events: [], ...over,
});
const status = (over: Partial<ApplyStatusDto> = {}): ApplyStatusDto => ({
  available: true, unavailableReason: null, enabled: true, withinWindow: true, worker: null, sites: [], totalToday: 0, totalCap: 30,
  queued: 0, needsHuman: 0, running: 0, waiting: null, ...over,
});
const HOST_REASON = applyAvailability({ HOST: '0.0.0.0' }).reason!;
const question: PendingQuestion = {
  question: { id: 'q', label: 'Salário', help: '', kind: 'number', options: [], required: true, maxLength: null },
  category: 'unknown', kind: 'unanswered', proposal: null,
};

describe('item 1: the résumé link says what happened to it', () => {
  it('says "enviado" only for a sent application', () => {
    expect(resumeLinkLabel('submitted')).toBe('Currículo enviado');
    expect(resumeLinkLabel('dry_run_ready')).toBe('Currículo do ensaio');
    for (const s of APPLICATION_STATUSES.filter((x) => x !== 'submitted' && x !== 'dry_run_ready')) {
      expect(resumeLinkLabel(s), s).toBe('Currículo preparado');
    }
  });
});

describe('item 2: a failure without a reason still says what happened', () => {
  it('shows the detail of a failed application with a plain lead-in', () => {
    expect(applicationReasonText({ status: 'failed', reason: null, detail: 'O formulário não carregou.' })).toBe('O que aconteceu: O formulário não carregou.');
    expect(applicationReasonText({ status: 'failed', reason: null, detail: '  ' })).toBe('');
    expect(applicationReasonText({ status: 'failed', reason: null, detail: null })).toBe('');
    // Com motivo, vale a frase do motivo (com o detalhe).
    expect(applicationReasonText({ status: 'failed', reason: 'closed', detail: 'x' })).toBe('A vaga não aceita mais candidaturas: x');
    // Detalhe sem motivo fora de uma falha continua sem frase.
    expect(applicationReasonText({ status: 'cancelled', reason: null, detail: 'x' })).toBe('');
  });
});

describe('items 6 and 9: the drawer says each thing once', () => {
  it('leaves the line above empty when the form questions or the unconfirmed notice already say it', () => {
    const asking = app({ status: 'needs_human', reason: 'question', detail: '2 perguntas precisam de você', pendingQuestions: [question, question] });
    expect(applicationHeadline(asking)).toBe('');
    expect(applicationHeadline(app({ status: 'needs_human', reason: 'confirm_submission' }))).toBe('');
    // Pergunta sem pendência carregada: a frase do motivo fica.
    expect(applicationHeadline(app({ status: 'needs_human', reason: 'question', pendingQuestions: [] }))).toMatch(/perguntas do formulário/);
    expect(applicationHeadline(app({ status: 'skipped', reason: 'already_applied' }))).toMatch(/por conta própria/);
    expect(applicationHeadline(app({ status: 'failed', detail: 'Tempo esgotado.' }))).toBe('O que aconteceu: Tempo esgotado.');
  });
});

describe('item 3: work that cannot run now is not offered', () => {
  it('gives the reason the queue buttons are off, only while applications cannot run', () => {
    expect(queueBlockedReason(undefined)).toBeNull();
    expect(queueBlockedReason(status())).toBeNull();
    expect(queueBlockedReason(status({ available: false, unavailableReason: 'Sem navegador.' }))).toBe('Sem navegador.');
    expect(queueBlockedReason(status({ available: false, unavailableReason: null }))).toBe('A candidatura automática não está disponível.');
  });

  it('knows when a refusal only repeats the reason already on screen', () => {
    expect(repeatsNotice('Sem navegador.', 'Sem navegador.')).toBe(true);
    expect(repeatsNotice(' Sem navegador. ', 'Sem navegador.')).toBe(true);
    expect(repeatsNotice('Esta candidatura já foi enviada.', 'Sem navegador.')).toBe(false);
    expect(repeatsNotice('Sem navegador.', null)).toBe(false);
  });
});

describe('item 4: the drawer says why "Aplicar com IA" is not there', () => {
  const dto = (over: Partial<JobApplicationDto>): JobApplicationDto => ({ application: null, site: 'fake', canApply: false, cannotApplyReason: null, ...over });

  it('shows one quiet line when the feature is off or cannot run, and nothing for the other reasons', () => {
    expect(applySectionView(dto({ cannotApplyReason: 'apply_disabled' }))).toBe('note');
    expect(applySectionView(dto({ cannotApplyReason: 'apply_unavailable' }))).toBe('note');
    for (const reason of ['unsupported_site', 'already_applied', 'blocked', 'already_exists'] as const) {
      expect(applySectionView(dto({ cannotApplyReason: reason })), reason).toBe('hidden');
    }
    expect(applySectionNote(dto({ cannotApplyReason: 'apply_disabled' }), status())).toBe('Candidatura automática desligada em Configurações.');
    expect(applySectionNote(dto({ cannotApplyReason: 'apply_unavailable' }), status({ available: false, unavailableReason: 'Sem navegador.' })))
      .toBe('Sem navegador.');
    // O estado ainda não chegou (ou já voltou): uma frase geral, nunca vazia.
    expect(applySectionNote(dto({ cannotApplyReason: 'apply_unavailable' }), undefined)).toBe('A candidatura automática não está disponível agora.');
    expect(applySectionNote(dto({ cannotApplyReason: 'blocked' }), status())).toBeNull();
    expect(applySectionNote(dto({ canApply: true }), status())).toBeNull();
  });
});

describe('item 10: the API host check locks the settings, whoever reports it', () => {
  it('locks the options when both processes report the host reason', () => {
    const both = unavailableNotice(status({
      available: false, unavailableReason: HOST_REASON, worker: { available: false, reason: HOST_REASON, seenAt: 1 },
    }));
    expect(both).toEqual({ title: 'Indisponível neste endereço', reason: HOST_REASON, lockSettings: true });
  });

  it('locks them when the API host is wrong even if the worker reports a problem of its own', () => {
    const notice = unavailableNotice(status({
      available: false, unavailableReason: HOST_REASON, worker: { available: false, reason: 'Sem navegador.', seenAt: 1 },
    }));
    expect(notice?.lockSettings).toBe(true);
  });

  it('keeps them editable only for a worker problem that is not the host one', () => {
    const notice = unavailableNotice(status({
      available: false, unavailableReason: 'Sem navegador.', worker: { available: false, reason: 'Sem navegador.', seenAt: 1 },
    }));
    expect(notice).toEqual({ title: 'O worker não consegue se candidatar agora', reason: 'Sem navegador.', lockSettings: false });
    // Um worker que não deu motivo: a API usa uma frase dela, e continua sendo um problema do worker.
    const silent = unavailableNotice(status({
      available: false, unavailableReason: 'O worker disse que não pode rodar.', worker: { available: false, reason: null, seenAt: 1 },
    }));
    expect(silent?.lockSettings).toBe(false);
    // Indisponível sem problema do worker: só pode ser o host.
    expect(unavailableNotice(status({ available: false, unavailableReason: HOST_REASON, worker: { available: true, reason: null, seenAt: 1 } }))?.lockSettings)
      .toBe(true);
  });
});

describe('item 11: "Já apliquei por conta própria" always reaches the API', () => {
  const job = (id: number, column: Column, position: number) => ({ id, column, position }) as JobListItemDto;

  it('moves a card before Aplicada to the end of Aplicada', () => {
    const board = [job(1, 'selecionadas', 0), job(2, 'aplicada', 0)];
    expect(markAppliedPlan('selecionadas', board, 1)).toEqual({ action: 'move', column: 'aplicada' });
    expect(markAppliedPlan('selecionadas', undefined, 1)).toEqual({ action: 'move', column: 'aplicada' });
  });

  it('re-sends the column when the move would change nothing (the board already has the card last in Aplicada)', () => {
    const board = [job(2, 'aplicada', 0), job(1, 'aplicada', 1)];
    expect(markAppliedPlan('selecionadas', board, 1)).toEqual({ action: 'resend', column: 'aplicada' });
  });

  it('re-sends the column of a card already in Aplicada or later', () => {
    expect(markAppliedPlan('aplicada', [job(1, 'aplicada', 0)], 1)).toEqual({ action: 'resend', column: 'aplicada' });
    expect(markAppliedPlan('entrevista', undefined, 1)).toEqual({ action: 'resend', column: 'entrevista' });
  });
});
