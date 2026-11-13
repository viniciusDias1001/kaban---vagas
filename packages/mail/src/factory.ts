import { join } from 'node:path';
import { createFakeMailbox } from './fake';
import { createGmailMailbox } from './gmail';
import { createFakeNotifier, createTelegramNotifier, findTelegramChatId, type PhoneNotifier } from './notify';
import type { Mailbox } from './types';

/** `<dataDir>/fake-mail` */
export function fakeMailDir(dataDir: string): string {
  return join(dataDir, 'fake-mail');
}

/** `FAKE_MAIL=1`: a caixa falsa em `fakeMailDir(dataDir)`; senão o Gmail. */
export function mailboxFor(env: { FAKE_MAIL?: string }, dataDir: string, creds: { address: string; password: string }): Mailbox {
  return env.FAKE_MAIL === '1' ? createFakeMailbox(fakeMailDir(dataDir), creds) : createGmailMailbox(creds);
}

/** O chat que "Achar meu chat" acha com `FAKE_MAIL=1`. */
export const FAKE_TELEGRAM_CHAT_ID = '100200300';

/** `FAKE_MAIL=1`: o aviso falso, que escreve em `fakeMailDir(dataDir)/phone.json`; senão o Telegram. */
export function phoneNotifierFor(env: { FAKE_MAIL?: string }, dataDir: string, opts: { token: string; chatId: string }): PhoneNotifier {
  return env.FAKE_MAIL === '1' ? createFakeNotifier(fakeMailDir(dataDir)) : createTelegramNotifier(opts);
}

/** `FAKE_MAIL=1`: sempre `FAKE_TELEGRAM_CHAT_ID`, sem rede; senão `findTelegramChatId`. */
export function findPhoneChatFor(env: { FAKE_MAIL?: string }, token: string): Promise<string | null> {
  return env.FAKE_MAIL === '1' ? Promise.resolve(FAKE_TELEGRAM_CHAT_ID) : findTelegramChatId({ token });
}
