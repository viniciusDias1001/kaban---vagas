import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAIL_LIMITS } from '@kv/shared';
import {
  BODY_MAX_BYTES, GMAIL, HEAD_QUERY, TIMEOUT_MS, findSpecialUse, imapOptions, inboxSearch, parseHeaderBlock, pickNewUids,
  readCapped, sendOptions, smtpOptions, threadSearch, toMailError, toRawMail,
} from './gmail';
import { MailAuthError, MailTransientError } from './types';

const creds = { address: 'maria@example.com', password: 'abcdefghijklmnop' };

describe('toMailError', () => {
  it('maps a refused login to MailAuthError and anything else to MailTransientError', () => {
    expect(toMailError(Object.assign(new Error('Invalid credentials'), { authenticationFailed: true }))).toBeInstanceOf(MailAuthError);
    expect(toMailError(Object.assign(new Error('535 Username and Password not accepted'), { responseCode: 535 }))).toBeInstanceOf(MailAuthError);
    expect(toMailError(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }))).toBeInstanceOf(MailAuthError);
    expect(toMailError(Object.assign(new Error('x'), { serverResponseCode: 'AUTHENTICATIONFAILED' }))).toBeInstanceOf(MailAuthError);
    expect(toMailError(new Error('ETIMEDOUT'))).toBeInstanceOf(MailTransientError);
    expect(toMailError('qualquer coisa')).toBeInstanceOf(MailTransientError);
  });
  it('uses fixed messages', () => {
    expect(toMailError({ authenticationFailed: true }).message).toBe('O Gmail recusou o login. Confira o endereço e a senha de app.');
    expect(toMailError(new Error('ECONNRESET')).message).toBe('Não foi possível falar com o Gmail agora.');
  });
  it('never puts the password in an error message', () => {
    expect(toMailError(new Error('AUTHENTICATE PLAIN abcdefghijklmnop failed')).message).not.toContain('abcdefghijklmnop');
    const auth = toMailError(Object.assign(new Error('LOGIN maria@example.com abcdefghijklmnop'), { authenticationFailed: true }));
    expect(auth.message).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(auth)).not.toContain('abcdefghijklmnop');
    expect((auth as Error & { cause?: unknown }).cause).toBeUndefined();
  });
  it('keeps an error that is already translated', () => {
    const e = new MailAuthError('x');
    expect(toMailError(e)).toBe(e);
  });
});

describe('connection settings', () => {
  it('uses the Gmail servers over TLS with 30 s timeouts', () => {
    expect(GMAIL).toEqual({ imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 });
    expect(TIMEOUT_MS).toBe(30_000);
    expect(imapOptions(creds)).toMatchObject({
      host: 'imap.gmail.com', port: 993, secure: true, auth: { user: 'maria@example.com', pass: 'abcdefghijklmnop' },
      logger: false, disableAutoIdle: true, connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 30_000,
    });
    expect(smtpOptions(creds)).toMatchObject({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'maria@example.com', pass: 'abcdefghijklmnop' },
      connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 30_000, disableFileAccess: true, disableUrlAccess: true,
    });
  });
  it('asks only for headers and structure, never the message source', () => {
    expect(HEAD_QUERY).toMatchObject({ uid: true, envelope: true, bodyStructure: true, threadId: true, internalDate: true });
    expect(HEAD_QUERY).not.toHaveProperty('source');
    expect(HEAD_QUERY).not.toHaveProperty('bodyParts');
    expect(HEAD_QUERY.headers).toEqual(['reply-to', 'in-reply-to', 'references', 'auto-submitted', 'list-id', 'list-unsubscribe', 'precedence']);
    expect(BODY_MAX_BYTES).toBe(4 * MAIL_LIMITS.bodyChars);
  });
});

describe('search and selection', () => {
  it('continues after the last UID or restarts from the date', () => {
    expect(inboxSearch({ uidValidity: 5, afterUid: 10, since: 0, limit: 50 }, 5)).toEqual({ restart: false, query: { uid: '11:*' } });
    expect(inboxSearch({ uidValidity: 4, afterUid: 10, since: Date.UTC(2026, 9, 1), limit: 50 }, 5))
      .toEqual({ restart: true, query: { since: new Date(Date.UTC(2026, 9, 1)) } });
    expect(inboxSearch({ uidValidity: null, afterUid: null, since: 1000, limit: 50 }, 5)).toEqual({ restart: true, query: { since: new Date(1000) } });
  });
  it('keeps the oldest new UIDs up to the limit', () => {
    // `11:*` devolve a última mensagem mesmo quando ela é a de UID 10.
    expect(pickNewUids([10], 10, 50)).toEqual([]);
    expect(pickNewUids([14, 12, 11, 13], 10, 2)).toEqual([11, 12]);
    expect(pickNewUids([3, 1, 2], null, 50)).toEqual([1, 2, 3]);
  });
  it('finds All mail and Sent by the special-use mark, never by the name', () => {
    const list = [
      { path: 'INBOX', flags: new Set<string>(), specialUse: '\\Inbox', specialUseSource: 'extension' as const },
      { path: '[Gmail]/Enviados', flags: new Set(['\\HasNoChildren', '\\Sent']), specialUse: '\\Sent', specialUseSource: 'extension' as const },
      { path: '[Gmail]/Todos os e-mails', flags: new Set(['\\All']), specialUse: '\\All', specialUseSource: 'extension' as const },
      { path: 'Sent', flags: new Set<string>(), specialUse: '\\Sent', specialUseSource: 'name' as const },
    ];
    expect(findSpecialUse(list, '\\All')).toBe('[Gmail]/Todos os e-mails');
    expect(findSpecialUse(list, '\\Sent')).toBe('[Gmail]/Enviados');
    expect(findSpecialUse([list[3]!], '\\Sent')).toBeNull();
  });
  it('searches a thread by the Gmail thread id, or by the headers for other keys', () => {
    expect(threadSearch('1789123456789012345')).toEqual({ threadId: '1789123456789012345' });
    expect(threadSearch('a@x')).toEqual({ or: [{ header: { 'message-id': 'a@x' } }, { header: { references: 'a@x' } }] });
  });
});

describe('headers and messages', () => {
  const headers = Buffer.from(
    'Reply-To: Joana <joana@acme.com>\r\nReferences: <a@x>\r\n <b@x>\r\nAuto-Submitted: auto-replied\r\nList-Id: <vagas.acme.com>\r\nPrecedence: bulk\r\n\r\n',
  );
  it('parses folded header lines', () => {
    const h = parseHeaderBlock(headers);
    expect(h.get('references')).toBe('<a@x> <b@x>');
    expect(h.get('reply-to')).toBe('Joana <joana@acme.com>');
    expect(h.has('list-unsubscribe')).toBe(false);
  });

  it('turns a fetched message into a RawMail', () => {
    const msg = {
      seq: 1, uid: 42, threadId: '1789',
      envelope: {
        date: new Date(5000), subject: 'Entrevista', messageId: '<c@x>', inReplyTo: '<b@x>',
        from: [{ name: 'Joana Lima', address: 'Joana@Acme.com' }],
        replyTo: [{ name: 'Joana', address: 'Joana@Acme.com' }],
        to: [{ address: 'Maria@Example.com' }], cc: [{ address: 'rh@acme.com' }],
      },
      headers,
    };
    expect(toRawMail(msg, 'Olá', 7)).toEqual({
      uid: 42, messageId: 'c@x', threadKey: '1789', from: { address: 'joana@acme.com', name: 'Joana Lima' },
      to: ['maria@example.com', 'rh@acme.com'], replyTo: 'joana@acme.com', subject: 'Entrevista', date: 5000,
      inReplyTo: 'b@x', references: ['a@x', 'b@x'], autoSubmitted: true, listId: true, bulk: true, text: 'Olá',
    });
  });

  it('fills what the server left out', () => {
    // O ENVELOPE repete o From em Reply-To quando o cabeçalho não existe: sem cabeçalho, sem Reply-To.
    const msg = {
      seq: 1, uid: 9, internalDate: new Date(7000),
      envelope: { from: [{ address: 'joana@acme.com' }], replyTo: [{ address: 'joana@acme.com' }] },
      headers: Buffer.from('Auto-Submitted: no\r\nList-Unsubscribe: <mailto:x@acme.com>\r\n\r\n'),
    };
    expect(toRawMail(msg, '', 3)).toMatchObject({
      messageId: 'uid-3-9@sem-id.local', threadKey: 'uid-3-9@sem-id.local', from: { address: 'joana@acme.com', name: '' },
      replyTo: null, subject: '', date: 7000, inReplyTo: null, references: [], autoSubmitted: false, listId: false, bulk: true,
    });
  });

  it('keeps every usable Reply-To address and never an empty one', () => {
    const withReplyTo = (replyTo: { name?: string; address?: string }[]) => toRawMail(
      { uid: 1, envelope: { from: [{ address: 'joana@acme.com' }], replyTo }, headers: Buffer.from('Reply-To: x\r\n\r\n') }, '', 1,
    ).replyTo;
    // Grupo (`Recrutamento: ;`): o imapflow devolve o nome do grupo com endereço vazio.
    expect(withReplyTo([{ name: 'Recrutamento', address: '' }])).toBeNull();
    expect(withReplyTo([{ name: 'Recrutamento', address: '' }, { name: 'Ana', address: 'Ana@Acme.com' }])).toBe('ana@acme.com');
    // Dois endereços: os dois ficam, para quem decide o destinatário ver que não é um só.
    expect(withReplyTo([{ address: 'A@Acme.com' }, { address: 'b@globex.com' }])).toBe('a@acme.com, b@globex.com');
    expect(withReplyTo([])).toBeNull();
  });

  it('builds a plain-text reply in the thread with one attachment at most', () => {
    const opts = sendOptions({
      messageId: 'out-1@kv', from: 'maria@example.com', fromName: 'Maria Exemplo da Silva', to: 'joana@acme.com', subject: 'Re: Vaga',
      text: 'Segue.', inReplyTo: 'b@x', references: ['a@x', 'b@x'], attachment: { fileName: 'curriculo.pdf', content: Buffer.from('%PDF') },
    });
    expect(opts).toEqual({
      messageId: 'out-1@kv', from: { name: 'Maria Exemplo da Silva', address: 'maria@example.com' }, to: { name: '', address: 'joana@acme.com' }, subject: 'Re: Vaga',
      text: 'Segue.', inReplyTo: 'b@x', references: ['a@x', 'b@x'], attachments: [{ filename: 'curriculo.pdf', content: Buffer.from('%PDF') }],
    });
    expect(opts).not.toHaveProperty('html');
    expect(sendOptions({ ...{ messageId: 'm', from: 'a', fromName: 'A', to: 'b', subject: 's', text: 't', inReplyTo: 'i', references: [] }, attachment: null }).attachments).toEqual([]);
  });

  it('reads a downloaded part up to the byte limit', async () => {
    expect(await readCapped(Readable.from([Buffer.from('Olá, '), Buffer.from('Maria.')]), 100)).toBe('Olá, Maria.');
    expect(await readCapped(Readable.from([Buffer.from('a'.repeat(10)), Buffer.from('b'.repeat(10))]), 15)).toBe('a'.repeat(10) + 'b'.repeat(5));
  });
});
