import { join } from 'node:path';
import { createFakeMailbox } from './fake';
import { createGmailMailbox } from './gmail';
import type { Mailbox } from './types';

/** `<dataDir>/fake-mail` */
export function fakeMailDir(dataDir: string): string {
  return join(dataDir, 'fake-mail');
}

/** `FAKE_MAIL=1`: a caixa falsa em `fakeMailDir(dataDir)`; senão o Gmail. */
export function mailboxFor(env: { FAKE_MAIL?: string }, dataDir: string, creds: { address: string; password: string }): Mailbox {
  return env.FAKE_MAIL === '1' ? createFakeMailbox(fakeMailDir(dataDir), creds) : createGmailMailbox(creds);
}
