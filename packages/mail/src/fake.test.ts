import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeMailbox, deliverFakeMail, readFakeMailbox, writeFakeMailbox } from './fake';
import { rawMail } from './testing';
import { MailAuthError, type OutgoingMail } from './types';

const creds = { address: 'maria@example.com', password: 'senha-de-app' };
const outgoing = (over: Partial<OutgoingMail> = {}): OutgoingMail => ({
  messageId: 'out@kv',
  from: 'maria@example.com',
  fromName: 'Maria Exemplo da Silva',
  to: 'joana@acme.com',
  subject: 'Re: Olá',
  text: 'Segue meu telefone.',
  inReplyTo: 'a@x',
  references: ['a@x'],
  attachment: null,
  ...over,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kv-fake-mail-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('fake mailbox', () => {
  it('starts empty when there is no file', () => {
    expect(readFakeMailbox(dir)).toEqual({ uidValidity: 1, messages: [] });
  });

  it('lists the inbox after a UID and restarts when UIDVALIDITY differs', async () => {
    deliverFakeMail(dir, { subject: 'um', date: 1000 });
    deliverFakeMail(dir, { subject: 'dois', date: 2000 });
    const box = createFakeMailbox(dir, creds);
    expect((await box.fetchInbox({ uidValidity: 1, afterUid: 1, since: 0, limit: 50 })).mails.map((m) => m.subject)).toEqual(['dois']);
    expect((await box.fetchInbox({ uidValidity: 99, afterUid: 1, since: 1500, limit: 50 })).mails.map((m) => m.subject)).toEqual(['dois']);
    expect((await box.fetchInbox({ uidValidity: null, afterUid: null, since: 0, limit: 1 })).mails.map((m) => m.subject)).toEqual(['um']);
    expect((await box.fetchInbox({ uidValidity: null, afterUid: null, since: 0, limit: 1 })).uidValidity).toBe(1);
  });

  it('gives each delivery the next UID and keeps the given ids', () => {
    const a = deliverFakeMail(dir, { messageId: 'a@x', threadKey: 'a@x' });
    const b = deliverFakeMail(dir, {});
    expect([a.uid, b.uid]).toEqual([1, 2]);
    expect(a.messageId).toBe('a@x');
    expect(b.messageId).not.toBe(a.messageId);
    expect(readFakeMailbox(dir).messages.map((m) => m.folder)).toEqual(['inbox', 'inbox']);
  });

  it('sees mail delivered by another process', async () => {
    const box = createFakeMailbox(dir, creds);
    expect((await box.fetchInbox({ uidValidity: null, afterUid: null, since: 0, limit: 50 })).mails).toEqual([]);
    // Outro processo grava o arquivo direto, sem passar por esta caixa.
    writeFakeMailbox(dir, { uidValidity: 1, messages: [{ ...rawMail({ uid: 1, subject: 'de fora' }), folder: 'inbox' }] });
    expect((await box.fetchInbox({ uidValidity: null, afterUid: null, since: 0, limit: 50 })).mails.map((m) => m.subject)).toEqual(['de fora']);
    expect((await box.fetchInboxByUid(1))?.subject).toBe('de fora');
    expect(await box.fetchInboxByUid(2)).toBeNull();
  });

  it('writes the file atomically, leaving no temporary file behind', () => {
    deliverFakeMail(dir, { subject: 'um' });
    deliverFakeMail(dir, { subject: 'dois' });
    expect(readdirSync(dir)).toEqual(['mailbox.json']);
  });

  it('records what was sent and finds it in the sent folder', async () => {
    const box = createFakeMailbox(dir, creds);
    await box.send(outgoing({ messageId: 'out-1@kv', inReplyTo: 'a@x' }));
    expect(await box.sentExists('out-1@kv')).toBe(true);
    expect(await box.sentExists('out-2@kv')).toBe(false);
    expect(readFakeMailbox(dir).messages.at(-1)).toMatchObject({ folder: 'sent', messageId: 'out-1@kv' });
    expect((await box.fetchInbox({ uidValidity: null, afterUid: null, since: 0, limit: 50 })).mails).toEqual([]);
  });

  it('returns the whole thread, sent mail included, oldest first', async () => {
    deliverFakeMail(dir, { messageId: 'b@x', threadKey: 'a@x', inReplyTo: 'a@x', references: ['a@x'], date: 3000, subject: 'segunda' });
    deliverFakeMail(dir, { messageId: 'a@x', threadKey: 'a@x', date: 1000, subject: 'primeira' });
    deliverFakeMail(dir, { messageId: 'z@x', threadKey: 'z@x', date: 1500, subject: 'outro fio' });
    const box = createFakeMailbox(dir, creds);
    await box.send(outgoing({ messageId: 'out-1@kv', inReplyTo: 'b@x', references: ['a@x', 'b@x'] }));
    const thread = await box.fetchThread('a@x');
    expect(thread.map((m) => m.messageId)).toEqual(['a@x', 'b@x', 'out-1@kv']);
    expect(thread.at(-1)).toMatchObject({ from: { address: 'maria@example.com', name: 'Maria Exemplo da Silva' }, to: ['joana@acme.com'] });
  });

  it('refuses a wrong password', async () => {
    const bad = createFakeMailbox(dir, { address: 'maria@example.com', password: 'senha-errada' });
    await expect(bad.check()).rejects.toBeInstanceOf(MailAuthError);
    await expect(bad.fetchInbox({ uidValidity: null, afterUid: null, since: 0, limit: 50 })).rejects.toBeInstanceOf(MailAuthError);
    await expect(bad.send(outgoing())).rejects.toBeInstanceOf(MailAuthError);
    await expect(bad.close()).resolves.toBeUndefined();
    await expect(createFakeMailbox(dir, creds).check()).resolves.toBeUndefined();
  });
});
