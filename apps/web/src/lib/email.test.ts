import { describe, expect, it } from 'vitest';
import { ALERT_KINDS, type AlertDto, type MailMessageDto } from '@kv/shared/client';
import {
  alertAction, alertBody, alertTitle, alertsToNotify, mailActions, mailBadgeLabel, mailPasswordProblem, replyStateLabel, summaryLine,
} from './email';

const alert = (over: Partial<AlertDto> = {}): AlertDto => ({
  id: 1, kind: 'interview', jobId: 5, company: 'Acme', jobTitle: 'Dev', messageId: 9, replyId: null, subject: 'Olá', summary: null,
  payload: {}, createdAt: 0, ...over,
});

const message = (over: Partial<MailMessageDto> = {}): MailMessageDto => ({
  id: 1, threadKey: 't', direction: 'in', fromAddress: 'rh@example.com', fromName: 'RH', toAddress: 'maria@example.com', subject: 'Olá',
  sentAt: 0, body: '', kind: null, summary: null, lang: null, requests: [], jobId: 5, company: 'Acme', jobTitle: 'Dev', linkedBy: 'auto',
  corrected: false, backfill: false, movedTo: null, canUndoMove: false, replyState: null, replyOrigin: null, replyApprovedBy: null,
  alerted: false, ...over,
});

describe('alertTitle / alertBody / alertAction', () => {
  it('titles every alert kind', () => {
    for (const kind of ALERT_KINDS) expect(alertTitle(alert({ kind }))).not.toBe('');
  });

  it('names the company, or the subject when there is no card', () => {
    expect(alertTitle(alert({ kind: 'interview', company: 'Acme' }))).toBe('Convite de entrevista: Acme');
    expect(alertTitle(alert({ kind: 'offer', company: null, subject: 'Proposta' }))).toBe('Oferta: Proposta');
    expect(alertTitle(alert({ kind: 'unmatched', company: null, subject: 'Próximos passos' }))).toBe('E-mail sem vaga: Próximos passos');
    expect(alertTitle(alert({ kind: 'budget_waiting', payload: { waiting: 3 } }))).toBe(
      '3 e-mails de vaga esperando classificação (limite diário de IA atingido)',
    );
    expect(alertTitle(alert({ kind: 'move_confirm', payload: { moveTo: 'aplicada' } }))).toBe('Mover Acme para Aplicada?');
    expect(alertTitle(alert({ kind: 'missing_fact', company: 'Globex' }))).toBe('Globex pediu algo que você não salvou');
    expect(alertTitle(alert({ kind: 'draft' }))).toBe('Rascunho esperando você: Acme');
    expect(alertTitle(alert({ kind: 'mailbox_error' }))).toBe('A caixa de e-mail parou');
    expect(alertTitle(alert({ kind: 'backfill_summary' }))).toBe('Primeira leitura da caixa');
  });

  it('writes the body of each kind', () => {
    expect(alertBody(alert({ summary: 'Resumo', subject: 'Assunto' }))).toBe('Resumo');
    expect(alertBody(alert({ summary: null, subject: 'Assunto' }))).toBe('Assunto');
    expect(alertBody(alert({ summary: null, subject: null }))).toBe('');
    expect(alertBody(alert({ kind: 'missing_fact', payload: { missing: ['phone', 'salary'] } }))).toBe('Falta: Telefone, Pretensão salarial');
    expect(alertBody(alert({ kind: 'backfill_summary', payload: { counts: { reprovacao: 2 }, total: 4 } }))).toBe('Li 4 e-mails de vagas: 2 reprovações.');
    expect(alertBody(alert({ kind: 'backfill_summary' }))).toBe('Li 0 e-mails de vagas.');
    expect(alertBody(alert({ kind: 'mailbox_error' }))).toBe('Abra Configurações > E-mail para reconectar.');
    expect(alertBody(alert({ kind: 'mailbox_error', payload: { reason: 'Senha recusada.' } }))).toBe('Senha recusada.');
  });

  it('maps each kind to its action', () => {
    expect(ALERT_KINDS.map((k) => alertAction(k))).toEqual([
      'review_draft', 'open_job', 'answer_fact', 'review_draft', 'confirm_move', 'link', 'open_settings', 'open_list', 'classify_anyway',
    ]);
  });
});

describe('summaryLine', () => {
  it('writes the first-read summary', () => {
    expect(summaryLine({ reprovacao: 5, entrevista: 2, oferta: 1, recebimento: 6 }, 14)).toBe('Li 14 e-mails de vagas: 5 reprovações, 2 convites, 1 oferta.');
    expect(summaryLine({ reprovacao: 1 }, 1)).toBe('Li 1 e-mail de vaga: 1 reprovação.');
    expect(summaryLine({ pedido: 2, oferta: 2, entrevista: 1 }, 5)).toBe('Li 5 e-mails de vagas: 1 convite, 2 ofertas, 2 pedidos.');
  });

  it('ends after the total when there is nothing to list', () => {
    expect(summaryLine({ recebimento: 3 }, 3)).toBe('Li 3 e-mails de vagas.');
    expect(summaryLine({}, 0)).toBe('Li 0 e-mails de vagas.');
  });
});

describe('alertsToNotify', () => {
  it('notifies each interview or offer once', () => {
    const list = [alert({ id: 1, kind: 'interview' }), alert({ id: 2, kind: 'draft' }), alert({ id: 3, kind: 'offer' })];
    expect(alertsToNotify(list, new Set(['alert-1'])).map((a) => a.id)).toEqual([3]);
    expect(alertsToNotify(list, new Set()).map((a) => a.id)).toEqual([1, 3]);
  });
});

describe('labels', () => {
  it('labels each reply state and badge', () => {
    expect(replyStateLabel('aprovada')).toBe('Aprovada, na fila de envio');
    expect(replyStateLabel('falhou')).toBe('O envio falhou');
    expect(replyStateLabel('rascunho')).toBe('Rascunho');
    expect(replyStateLabel('enviando')).toBe('Enviando');
    expect(replyStateLabel('enviada')).toBe('Enviada');
    expect(replyStateLabel('descartada')).toBe('Descartada');
    expect(mailBadgeLabel('entrevista')).toBe('entrevista');
    expect(mailBadgeLabel('oferta')).toBe('oferta');
    expect(mailBadgeLabel('pedido')).toBe('pediu informação');
  });
});

describe('mailPasswordProblem', () => {
  it('checks an app password the way the server does', () => {
    expect(mailPasswordProblem('abcd efgh ijkl mnop')).toBeNull();
    expect(mailPasswordProblem('a b c')).not.toBeNull();
    expect(mailPasswordProblem('   ')).not.toBeNull();
    expect(mailPasswordProblem('a'.repeat(65))).not.toBeNull();
    expect(mailPasswordProblem('a'.repeat(64))).toBeNull();
    expect(mailPasswordProblem('abcdefgé12345')).not.toBeNull();
  });
});

describe('mailActions', () => {
  it('says what the app did with a mail', () => {
    expect(mailActions(message({ movedTo: 'perdida' }))).toEqual(['moveu o card para Perdida']);
    expect(mailActions(message({ replyState: 'enviada', replyApprovedBy: 'auto' }))).toEqual(['respondeu sozinho']);
    expect(mailActions(message({ replyState: 'enviada', replyApprovedBy: 'owner' }))).toEqual(['respondeu com o seu OK']);
    expect(mailActions(message({ movedTo: 'entrevista', replyState: 'rascunho', alerted: true }))).toEqual(['moveu o card para Entrevista', 'rascunho esperando você']);
    expect(mailActions(message({ replyState: 'descartada' }))).toEqual(['resposta descartada']);
    expect(mailActions(message({ replyState: 'falhou' }))).toEqual(['envio falhou']);
    expect(mailActions(message({ alerted: true }))).toEqual(['alertou você']);
    expect(mailActions(message({ corrected: true }))).toEqual(['classificação corrigida']);
    expect(mailActions(message({}))).toEqual([]);
  });
});
