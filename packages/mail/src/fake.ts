import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_FAILED_TEXT } from './gmail';
import { rawMail } from './testing';
import { clipBody, threadKeyFromHeaders } from './text';
import { MailAuthError, type Mailbox, type OutgoingMail, type RawMail } from './types';

export interface FakeStored extends RawMail { folder: 'inbox' | 'sent' }
export interface FakeMailboxState { uidValidity: number; messages: FakeStored[] }

/** Senha que a caixa falsa recusa, para os testes de login recusado. */
const WRONG_PASSWORD = 'senha-errada';
const FILE = 'mailbox.json';
const LOCK = 'mailbox.lock';
/** Trava largada por um processo que caiu é apagada depois deste tempo. */
const STALE_LOCK_MS = 5_000;
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** No Windows, ler ou trocar o arquivo enquanto outro processo o troca falha por um instante: tenta de novo. */
function retrying<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 50 || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      pause(20);
    }
  }
}

/** Três processos (API, worker e o teste) mexem no mesmo arquivo: quem lê, muda e grava segura esta trava. */
function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, LOCK);
  let fd: number | null = null;
  for (let attempt = 0; fd === null; attempt++) {
    try {
      fd = openSync(lock, 'wx');
    } catch (e) {
      // EEXIST: outro processo segura a trava. EPERM/EACCES/EBUSY: no Windows, a trava está sendo apagada.
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if ((code !== 'EEXIST' && !BUSY.has(code)) || attempt >= 500) throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
      } catch { /* a trava sumiu entre as duas chamadas */ }
      pause(10);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

export function readFakeMailbox(dir: string): FakeMailboxState {
  const file = join(dir, FILE);
  if (!existsSync(file)) return { uidValidity: 1, messages: [] };
  return JSON.parse(retrying(() => readFileSync(file, 'utf8'))) as FakeMailboxState;
}

export function writeFakeMailbox(dir: string, state: FakeMailboxState): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  try {
    retrying(() => renameSync(tmp, join(dir, FILE)));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function nextUid(state: FakeMailboxState): number {
  return state.messages.reduce((max, m) => Math.max(max, m.uid), 0) + 1;
}

function withoutFolder({ folder: _folder, ...mail }: FakeStored): RawMail {
  return mail;
}

/** Acrescenta à caixa de entrada com o próximo UID; para os testes e o e2e. */
export function deliverFakeMail(dir: string, mail: Partial<RawMail>): RawMail {
  return withLock(dir, () => {
    const state = readFakeMailbox(dir);
    const uid = nextUid(state);
    const base = { ...rawMail(), date: Date.now(), ...mail, uid, messageId: mail.messageId ?? `fake-${uid}@example.com` };
    const stored: FakeStored = { ...base, threadKey: mail.threadKey ?? threadKeyFromHeaders(base), folder: 'inbox' };
    writeFakeMailbox(dir, { ...state, messages: [...state.messages, stored] });
    return withoutFolder(stored);
  });
}

/** Caixa guardada em `<dir>/mailbox.json`, relida a cada chamada. Senha `senha-errada`: `check` e as demais lançam MailAuthError. `send` grava a mensagem em 'sent' (o Gmail copia sozinho). */
export function createFakeMailbox(dir: string, creds: { address: string; password: string }): Mailbox {
  const login = (): void => {
    if (creds.password === WRONG_PASSWORD) throw new MailAuthError(AUTH_FAILED_TEXT);
  };
  const byAge = (a: FakeStored, b: FakeStored): number => a.date - b.date || a.uid - b.uid;

  return {
    async check() {
      login();
    },
    async fetchInbox({ uidValidity, afterUid, since, limit }) {
      login();
      const state = readFakeMailbox(dir);
      const restart = afterUid === null || uidValidity !== state.uidValidity;
      const mails = state.messages
        .filter((m) => m.folder === 'inbox' && (restart ? m.date >= since : m.uid > (afterUid ?? 0)))
        .sort((a, b) => a.uid - b.uid)
        .slice(0, limit)
        .map(withoutFolder);
      return { uidValidity: state.uidValidity, mails };
    },
    async fetchInboxByUid(uid) {
      login();
      const found = readFakeMailbox(dir).messages.find((m) => m.folder === 'inbox' && m.uid === uid);
      return found ? withoutFolder(found) : null;
    },
    async fetchThread(threadKey) {
      login();
      return readFakeMailbox(dir).messages.filter((m) => m.threadKey === threadKey).sort(byAge).map(withoutFolder);
    },
    async sentExists(messageId) {
      login();
      return readFakeMailbox(dir).messages.some((m) => m.folder === 'sent' && m.messageId === messageId);
    },
    async send(mail: OutgoingMail) {
      login();
      withLock(dir, () => {
        const state = readFakeMailbox(dir);
        // Como no Gmail, a resposta entra no fio da mensagem a que responde.
        const parentIds = [mail.inReplyTo, ...mail.references];
        const parent = state.messages.find((m) => parentIds.includes(m.messageId));
        const stored: FakeStored = {
          uid: nextUid(state),
          messageId: mail.messageId,
          threadKey: parent?.threadKey ?? threadKeyFromHeaders(mail),
          from: { address: mail.from.toLowerCase(), name: mail.fromName },
          to: [mail.to.toLowerCase()],
          replyTo: null,
          subject: mail.subject,
          date: Date.now(),
          inReplyTo: mail.inReplyTo,
          references: mail.references,
          autoSubmitted: false,
          listId: false,
          bulk: false,
          text: clipBody(mail.text),
          folder: 'sent',
        };
        writeFakeMailbox(dir, { ...state, messages: [...state.messages, stored] });
      });
    },
    async close() {},
  };
}
