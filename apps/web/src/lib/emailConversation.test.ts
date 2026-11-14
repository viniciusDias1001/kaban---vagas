import { describe, expect, it } from 'vitest';
import type { MailMessageDto, MailReplyDto } from '@kv/shared/client';
import { emailConversation, historyMailLine, replyGoesElsewhere, threadConversation } from './email';

const message = (over: Partial<MailMessageDto> = {}): MailMessageDto => ({
  id: 1, messageId: '<in-1@acme.example>', threadKey: 't1', direction: 'in', fromAddress: 'ana@acme.example', fromName: 'Ana',
  toAddress: 'maria@example.com', subject: 'Telefone?', sentAt: 1_000, body: 'Qual o seu telefone?', kind: 'pedido', summary: null,
  lang: 'pt-BR', requests: [], jobId: 5, company: 'Acme', jobTitle: 'Dev', linkedBy: 'auto', corrected: false, backfill: false,
  movedTo: null, canUndoMove: false, replyState: null, replyOrigin: null, replyApprovedBy: null, alerted: false, ...over,
});

const reply = (over: Partial<MailReplyDto> = {}): MailReplyDto => ({
  id: 10, messageId: 1, origin: 'facts', items: ['phone'], toAddress: 'ana@acme.example', subject: 'Re: Telefone?',
  body: 'Meu telefone é (11) 90000-0000.', attachResume: false, state: 'enviada', note: null, createdAt: 1_100, sentAt: 1_200,
  outMessageId: null, ...over,
});

const out = (id: number, messageId: string, over: Partial<MailMessageDto> = {}) =>
  message({
    id, messageId, direction: 'out', fromAddress: 'maria@example.com', toAddress: 'ana@acme.example', subject: 'Re: Telefone?',
    body: 'Meu telefone é (11) 90000-0000.', kind: null, sentAt: 1_200 + id, ...over,
  });

describe('emailConversation', () => {
  it('pairs each sent reply with its own stored copy by Message-ID, even when two have the same text and address', () => {
    const asked1 = message({ id: 1, messageId: '<in-1@acme.example>', replyApprovedBy: 'auto' });
    const asked2 = message({ id: 2, messageId: '<in-2@acme.example>', sentAt: 2_000, replyApprovedBy: 'owner' });
    const r1 = reply({ id: 10, messageId: 1, outMessageId: '<out-a@kanban-vagas.local>' });
    const r2 = reply({ id: 11, messageId: 2, outMessageId: '<out-b@kanban-vagas.local>' });
    // As cópias chegam na ordem inversa da das respostas: o texto e o endereço não decidem nada.
    const copyB = out(3, '<out-b@kanban-vagas.local>', { sentAt: 3_000 });
    const copyA = out(4, '<out-a@kanban-vagas.local>', { sentAt: 4_000 });

    const items = emailConversation({ messages: [asked1, asked2, copyB, copyA], replies: [r1, r2] });

    expect(items.map((i) => i.message.id)).toEqual([1, 2, 3, 4]);
    expect(items[0]).toMatchObject({ reply: null, sentReply: null });
    expect(items[1]).toMatchObject({ reply: null, sentReply: null });
    expect(items[2]).toMatchObject({ sentReply: { id: 11 }, origin: { id: 2, replyApprovedBy: 'owner' } });
    expect(items[3]).toMatchObject({ sentReply: { id: 10 }, origin: { id: 1, replyApprovedBy: 'auto' } });
  });

  it('leaves an outgoing mail without a reply unpaired, even with the same text as a sent reply', () => {
    const asked = message();
    const sent = reply({ outMessageId: '<out-a@kanban-vagas.local>' });
    const own = out(2, '<own@gmail.example>');

    const items = emailConversation({ messages: [asked, own], replies: [sent] });

    expect(items[1]).toMatchObject({ message: { id: 2 }, sentReply: null, origin: null, reply: null });
    // A cópia ainda não foi guardada: a resposta enviada aparece sob o e-mail recebido.
    expect(items[0]).toMatchObject({ reply: { id: 10 }, sentReply: null });
  });

  it('shows a sent reply whose copy is not stored yet under its received mail', () => {
    const items = emailConversation({ messages: [message()], replies: [reply({ outMessageId: null })] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reply: { id: 10, state: 'enviada' }, sentReply: null });
  });

  it('keeps a draft under its received mail', () => {
    const items = emailConversation({ messages: [message()], replies: [reply({ state: 'rascunho', sentAt: null })] });
    expect(items[0]).toMatchObject({ reply: { id: 10, state: 'rascunho' } });
  });
});

describe('historyMailLine', () => {
  it('names the kind and the subject', () => {
    expect(historyMailLine({ kind: 'reprovacao', subject: 'Sua candidatura na Acme' })).toBe('E-mail — Reprovação: Sua candidatura na Acme');
  });

  it('works without a kind and without a subject', () => {
    expect(historyMailLine({ kind: null, subject: 'Olá' })).toBe('E-mail — Olá');
    expect(historyMailLine({ kind: 'entrevista', subject: '  ' })).toBe('E-mail — Entrevista: (sem assunto)');
  });
});

describe('replyGoesElsewhere', () => {
  it('warns when the reply goes to an address that is not the sender, ignoring case and spaces', () => {
    const invite = message({ fromAddress: 'ana@acme.example' });
    expect(replyGoesElsewhere(reply({ toAddress: 'agenda@scheduler.example' }), invite)).toBe(true);
    expect(replyGoesElsewhere(reply({ toAddress: ' ANA@Acme.example ' }), invite)).toBe(false);
  });

  it('finds the origin among the loaded messages, and stays quiet when it is not there', () => {
    const messages = [message({ id: 1, fromAddress: 'ana@acme.example' }), message({ id: 2, fromAddress: 'rh@globex.example' })];
    expect(replyGoesElsewhere(reply({ messageId: 2, toAddress: 'rh@globex.example' }), messages)).toBe(false);
    expect(replyGoesElsewhere(reply({ messageId: 1, toAddress: 'rh@globex.example' }), messages)).toBe(true);
    expect(replyGoesElsewhere(reply({ messageId: 99, toAddress: 'x@example.com' }), messages)).toBe(false);
    expect(replyGoesElsewhere(reply({ toAddress: 'x@example.com' }), undefined)).toBe(false);
  });
});

describe('threadConversation', () => {
  it('keeps only the thread, in order, and shows a sent reply whose copy is not stored yet', () => {
    const asked = message({ id: 1, threadKey: 't1', sentAt: 1_000 });
    const other = message({ id: 2, threadKey: 't2', sentAt: 500 });
    const later = message({ id: 3, threadKey: 't1', sentAt: 3_000 });
    const sent = reply({ id: 10, messageId: 1, state: 'enviada', outMessageId: '<out-a@kanban-vagas.local>' });

    const items = threadConversation({ messages: [later, other, asked], replies: [sent] }, 't1');

    expect(items.map((i) => i.message.id)).toEqual([1, 3]);
    expect(items[0].reply).toMatchObject({ id: 10, state: 'enviada' });
  });

  it('shows the sent reply once, as its stored copy, when the copy is there', () => {
    const asked = message({ id: 1, threadKey: 't1' });
    const copy = out(2, '<out-a@kanban-vagas.local>', { threadKey: 't1' });
    const sent = reply({ id: 10, messageId: 1, state: 'enviada', outMessageId: '<out-a@kanban-vagas.local>' });

    const items = threadConversation({ messages: [asked, copy], replies: [sent] }, 't1');

    expect(items.map((i) => [i.message.id, i.reply?.id ?? null, i.sentReply?.id ?? null])).toEqual([[1, null, null], [2, null, 10]]);
  });
});
