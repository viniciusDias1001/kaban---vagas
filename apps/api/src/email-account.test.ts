import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import {
  closeDb, createReply, getMailAccount, insertMailMessage, mailMessages, openAlerts, raiseAlert, replyById, saveMailAccount, saveProfile,
  updateMailAccount, type Db,
} from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import {
  FAKE_TELEGRAM_CHAT_ID, FOLDERS_HIDDEN_TEXT, MailFolderError, MailTransientError, PhoneAlertError, fakeMailDir, type Mailbox,
} from '@kv/mail';
import { createSettingsService } from '@kv/settings';
import { TEST_DATA_DIR, TEST_SECRET, testAi } from './ai-testing';
import { buildApp } from './app';

/** Senha de app fictícia, como o Google mostra (em grupos) e como fica gravada (sem espaços). */
const PASSWORD = 'abcd efgh ijkl mnop';
const STORED = 'abcdefghijklmnop';
const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  build();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => closeDb(db));

/** App com APP_SECRET e a caixa falsa (ver `testAi`), salvo o que o teste pedir. Cada app tem o próprio limite. */
function build(over: Parameters<typeof testAi>[0] = {}) {
  app = buildApp(db, { ai: testAi({ env: { APP_SECRET: TEST_SECRET }, ...over }) });
  return app;
}
const get = (url: string) => app.inject({ method: 'GET', url });
const put = (url: string, payload: object) => app.inject({ method: 'PUT', url, payload });
const del = (url: string) => app.inject({ method: 'DELETE', url });
/** Um serviço de configurações sobre o mesmo banco e o mesmo APP_SECRET: lê o mesmo cofre que as rotas. */
const settings = () => createSettingsService(db, { env: { APP_SECRET: TEST_SECRET } });

async function seedMessage() {
  return insertMailMessage(db, {
    messageId: '<1@acme.example>', threadKey: '<1@acme.example>', direction: 'in', uid: 1, fromAddress: 'rh@acme.example',
    fromName: 'RH Acme', toAddress: 'maria@example.com', replyTo: null, subject: 'Recebemos sua candidatura', sentAt: NOW,
    body: 'Olá, Maria.', inReplyTo: null, refs: [], autoSubmitted: false, listId: false, backfill: false,
  }, NOW);
}

describe('GET /email/account', () => {
  it('reports a disconnected mailbox', async () => {
    expect((await get('/email/account')).json()).toMatchObject({
      connected: false, address: null, available: true, canStore: true, secretProblem: null, error: null, paused: false,
      connectedAt: null, lastReadAt: null, profileEmail: null, differsFromProfile: false,
    });
  });

  it('says why it cannot store the password without APP_SECRET', async () => {
    build({ env: {} });
    expect((await get('/email/account')).json()).toMatchObject({ canStore: false, secretProblem: expect.stringContaining('APP_SECRET') });
  });

  it('warns when the connected address is not the profile address', async () => {
    const profile = (email: string) => ({ ...SAMPLE_PROFILE, contact: { ...SAMPLE_PROFILE.contact, email } });
    await saveProfile(db, 'pt-BR', profile('maria.exemplo@example.org'), 'extraido');
    expect((await get('/email/account')).json()).toMatchObject({ profileEmail: 'maria.exemplo@example.org', differsFromProfile: false });
    await saveMailAccount(db, 'maria@example.com', NOW);
    expect((await get('/email/account')).json()).toMatchObject({ profileEmail: 'maria.exemplo@example.org', differsFromProfile: true });
    await saveProfile(db, 'pt-BR', profile('Maria@Example.com'), 'editado');
    expect((await get('/email/account')).json()).toMatchObject({ differsFromProfile: false });
  });
});

describe('PUT /email/account', () => {
  it('tests the login, stores the password encrypted and never returns it', async () => {
    const res = await put('/email/account', { address: 'maria@example.com', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: true, address: 'maria@example.com', error: null, connectedAt: NOW, paused: false });
    expect(res.body).not.toContain(STORED);
    expect(res.body).not.toContain('abcd');
    expect(await settings().readSecret('mail_password')).toEqual({ value: STORED });
    expect((await get('/email/account')).body).not.toContain('abcd');
  });

  it('refuses a wrong password with the cause and stores nothing', async () => {
    const res = await put('/email/account', { address: 'maria@example.com', password: 'senha-errada' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'mail_auth', message: expect.stringContaining('senha de app') });
    expect(res.body).not.toContain('senha-errada');
    expect(await getMailAccount(db)).toBeNull();
    expect(await settings().hasSecret('mail_password')).toBe(false);
  });

  it('answers 502 when the server cannot be reached, closes the mailbox and stores nothing', async () => {
    const closed: number[] = [];
    const broken = (creds: { address: string; password: string }): Mailbox =>
      ({
        async check() {
          // Um erro que repetisse a senha não pode chegar à resposta.
          throw new MailTransientError(`timeout for ${creds.password}`);
        },
        async close() {
          closed.push(1);
        },
      }) as unknown as Mailbox;
    build({ env: { APP_SECRET: TEST_SECRET }, mailbox: broken });
    const res = await put('/email/account', { address: 'maria@example.com', password: PASSWORD });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'mail_unreachable', message: 'Não foi possível falar com o Gmail agora.' });
    expect(res.body).not.toContain(STORED);
    expect(closed).toEqual([1]);
    expect(await getMailAccount(db)).toBeNull();
    expect(await settings().hasSecret('mail_password')).toBe(false);
  });

  it('says how to show the folders when All mail or Sent is hidden from IMAP, and stores nothing', async () => {
    const hidden = (): Mailbox =>
      ({
        async check() { throw new MailFolderError(FOLDERS_HIDDEN_TEXT); },
        async close() {},
      }) as unknown as Mailbox;
    build({ env: { APP_SECRET: TEST_SECRET }, mailbox: hidden });
    const res = await put('/email/account', { address: 'maria@example.com', password: PASSWORD });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'mail_unreachable', message: FOLDERS_HIDDEN_TEXT });
    expect(await getMailAccount(db)).toBeNull();
    expect(await settings().hasSecret('mail_password')).toBe(false);
  });

  it('closes the mailbox after a successful check', async () => {
    let closed = 0;
    const ok = (): Mailbox =>
      ({
        async check() {},
        async close() {
          closed++;
        },
      }) as unknown as Mailbox;
    build({ env: { APP_SECRET: TEST_SECRET }, mailbox: ok });
    expect((await put('/email/account', { address: 'maria@example.com', password: PASSWORD })).statusCode).toBe(200);
    expect(closed).toBe(1);
  });

  it('needs APP_SECRET and a local host', async () => {
    build({ env: {} });
    const noSecret = await put('/email/account', { address: 'maria@example.com', password: PASSWORD });
    expect(noSecret.statusCode).toBe(409);
    expect(noSecret.json()).toMatchObject({ error: 'no_app_secret', message: expect.stringContaining('APP_SECRET') });

    build();
    vi.stubEnv('HOST', '0.0.0.0');
    const offHost = await put('/email/account', { address: 'maria@example.com', password: PASSWORD });
    expect(offHost.statusCode).toBe(409);
    expect(offHost.json()).toMatchObject({ error: 'email_unavailable', message: expect.stringContaining('endereço local') });
    expect((await get('/email/account')).json()).toMatchObject({ available: false, unavailableReason: expect.stringContaining('HOST') });
    expect(await getMailAccount(db)).toBeNull();
  });

  it('rejects an invalid body without testing the login', async () => {
    const res = await put('/email/account', { address: 'não é e-mail', password: PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(STORED);
    // Não gastou a vez do limite: o próximo teste passa.
    expect((await put('/email/account', { address: 'maria@example.com', password: PASSWORD })).statusCode).toBe(200);
  });

  it('limits how often the login is tested', async () => {
    expect((await put('/email/account', { address: 'maria@example.com', password: PASSWORD })).statusCode).toBe(200);
    const second = await put('/email/account', { address: 'maria@example.com', password: PASSWORD });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: 'rate_limited', message: expect.stringContaining('Aguarde') });
    expect(second.headers['retry-after']).toBe('10');
  });

  it('reconnecting clears the mailbox error alert', async () => {
    await saveMailAccount(db, 'maria@example.com', NOW - 1000);
    await raiseAlert(db, { kind: 'mailbox_error', payload: { reason: 'O Gmail recusou o login.' } }, NOW - 1000);
    expect((await openAlerts(db)).map((a) => a.kind)).toEqual(['mailbox_error']);
    expect((await put('/email/account', { address: 'maria@example.com', password: PASSWORD })).statusCode).toBe(200);
    expect(await openAlerts(db)).toEqual([]);
  });

  it('reconnecting the same address keeps the reading point and the first read, and clears only the pause and the error', async () => {
    await saveMailAccount(db, 'maria@example.com', NOW - 2 * 86_400_000);
    await updateMailAccount(db, {
      uidValidity: 7, lastUid: 42, lastReadAt: NOW - 86_400_000, backfillDone: true, paused: true, error: 'O Gmail recusou o login.',
    });
    expect((await put('/email/account', { address: 'Maria@Example.com', password: PASSWORD })).statusCode).toBe(200);
    expect(await getMailAccount(db)).toMatchObject({
      address: 'maria@example.com', connectedAt: NOW - 2 * 86_400_000, uidValidity: 7, lastUid: 42, lastReadAt: NOW - 86_400_000,
      backfillDone: true, paused: false, error: null,
    });
    expect(await settings().readSecret('mail_password')).toEqual({ value: STORED });
  });

  it('connecting a different address starts over', async () => {
    await saveMailAccount(db, 'outra@example.com', NOW - 2 * 86_400_000);
    await updateMailAccount(db, { uidValidity: 7, lastUid: 42, backfillDone: true, paused: true, error: 'x' });
    expect((await put('/email/account', { address: 'maria@example.com', password: PASSWORD })).statusCode).toBe(200);
    expect(await getMailAccount(db)).toMatchObject({
      address: 'maria@example.com', connectedAt: NOW, uidValidity: null, lastUid: null, backfillDone: false, paused: false, error: null,
    });
  });

  it('never prints the password, on a refused or a successful login', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    for (const method of ['error', 'log', 'warn', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation(capture);

    const refused = await put('/email/account', { address: 'maria@example.com', password: 'senha-errada' });
    build(); // limite novo: o segundo teste não esbarra no primeiro
    const accepted = await put('/email/account', { address: 'maria@example.com', password: PASSWORD });

    expect(refused.statusCode).toBe(422);
    expect(accepted.statusCode).toBe(200);
    for (const res of [refused, accepted]) {
      expect(res.body).not.toContain('senha-errada');
      expect(res.body).not.toContain(STORED);
      expect(res.body).not.toContain(PASSWORD);
    }
    for (const line of lines) {
      expect(line).not.toContain('senha-errada');
      expect(line).not.toContain(STORED);
      expect(line).not.toContain('abcd');
    }
  });
});

describe('DELETE /email/account', () => {
  it('disconnecting deletes the credential and keeps or deletes the messages as asked', async () => {
    for (const messages of ['keep', 'delete'] as const) {
      await resetTestDb(db);
      build();
      expect((await put('/email/account', { address: 'maria@example.com', password: PASSWORD })).statusCode).toBe(200);
      await seedMessage();
      const res = await del(`/email/account?messages=${messages}`);
      expect(res.statusCode).toBe(204);
      expect(await getMailAccount(db)).toBeNull();
      expect(await settings().hasSecret('mail_password')).toBe(false);
      expect(await db.select().from(mailMessages)).toHaveLength(messages === 'keep' ? 1 : 0);
    }
  });

  it('keeps the messages when nothing is asked and rejects an unknown choice', async () => {
    await saveMailAccount(db, 'maria@example.com', NOW);
    await seedMessage();
    expect((await del('/email/account?messages=tudo')).statusCode).toBe(400);
    expect(await getMailAccount(db)).not.toBeNull();
    expect((await del('/email/account')).statusCode).toBe(204);
    expect(await getMailAccount(db)).toBeNull();
    expect(await db.select().from(mailMessages)).toHaveLength(1);
  });

  it('keeping the messages closes the mailbox alerts and sends queued replies back to draft', async () => {
    await saveMailAccount(db, 'maria@example.com', NOW);
    const messageId = (await seedMessage())!;
    const replyId = (await createReply(db, {
      messageId, origin: 'facts', items: ['salary'], toAddress: 'rh@acme.example', subject: 'Re: x', body: 'Olá', attachResume: false,
      state: 'aprovada', approvedBy: 'auto',
    }, NOW))!;
    await raiseAlert(db, { kind: 'mailbox_error', payload: { reason: 'O Gmail recusou o login.' } }, NOW);
    await raiseAlert(db, { kind: 'budget_waiting', payload: { waiting: 2 } }, NOW);
    await raiseAlert(db, { kind: 'backfill_summary', payload: { total: 1, counts: { recebimento: 1 } } }, NOW);

    expect((await del('/email/account?messages=keep')).statusCode).toBe(204);
    const note = 'A caixa foi desconectada antes do envio.';
    expect(await replyById(db, replyId)).toMatchObject({ state: 'rascunho', note, approvedBy: null });
    expect(await openAlerts(db)).toEqual([expect.objectContaining({ kind: 'draft', replyId, payload: { reason: note } })]);
  });

  it('off a local host, disconnects but refuses to delete the messages', async () => {
    await saveMailAccount(db, 'maria@example.com', NOW);
    await seedMessage();
    vi.stubEnv('HOST', '0.0.0.0');
    const refused = await del('/email/account?messages=delete');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'email_unavailable' });
    expect(await getMailAccount(db)).not.toBeNull();
    expect((await del('/email/account?messages=keep')).statusCode).toBe(204);
    expect(await getMailAccount(db)).toBeNull();
    expect(await db.select().from(mailMessages)).toHaveLength(1);
  });
});

describe('phone alert routes', () => {
  /** Token fictício no formato do BotFather. */
  const TOKEN = '123456:ABC-fake-bot-token';
  const post = (url: string) => app.inject({ method: 'POST', url });

  it('stores the bot token encrypted and never returns it', async () => {
    expect((await get('/email/account')).json()).toMatchObject({ phoneTokenSaved: false });
    const res = await put('/email/phone-token', { token: `  ${TOKEN}\n` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ phoneTokenSaved: true });
    expect(res.body).not.toContain(TOKEN);
    expect(await settings().readSecret('telegram_bot_token')).toEqual({ value: TOKEN });
    expect((await get('/email/account')).body).not.toContain(TOKEN);
    expect((await get('/settings')).body).not.toContain(TOKEN);

    expect((await del('/email/phone-token')).statusCode).toBe(204);
    expect(await settings().hasSecret('telegram_bot_token')).toBe(false);
    expect((await get('/email/account')).json()).toMatchObject({ phoneTokenSaved: false });
  });

  it('rejects a bad token without echoing it, and needs APP_SECRET and a local host', async () => {
    for (const token of ['curto', 'com espaço no meio', 'x'.repeat(101)]) {
      const res = await put('/email/phone-token', { token });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(token);
    }
    build({ env: {} });
    const noSecret = await put('/email/phone-token', { token: TOKEN });
    expect(noSecret.statusCode).toBe(409);
    expect(noSecret.json()).toMatchObject({ error: 'no_app_secret' });
    build();
    vi.stubEnv('HOST', '0.0.0.0');
    for (const res of [await put('/email/phone-token', { token: TOKEN }), await post('/email/phone-chat'), await post('/email/phone-test')]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'email_unavailable' });
    }
    expect(await settings().hasSecret('telegram_bot_token')).toBe(false);
  });

  it('does not delete the bot token off a local host', async () => {
    await settings().saveSecret('telegram_bot_token', TOKEN);
    vi.stubEnv('HOST', '0.0.0.0');
    const res = await del('/email/phone-token');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'email_unavailable', message: expect.stringContaining('HOST') });
    expect(await settings().hasSecret('telegram_bot_token')).toBe(true);
  });

  it('finds the chat, stores it and answers it; with nobody writing to the bot, says what to do', async () => {
    expect((await post('/email/phone-chat')).json()).toMatchObject({ error: 'no_phone_token', message: 'Grave o token do bot antes.' });
    await settings().saveSecret('telegram_bot_token', TOKEN);
    const tokens: string[] = [];
    build({
      env: { APP_SECRET: TEST_SECRET },
      findPhoneChat: async (token) => {
        tokens.push(token);
        return '42';
      },
    });
    const res = await post('/email/phone-chat');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ chatId: '42' });
    expect(tokens).toEqual([TOKEN]);
    expect((await get('/settings')).json().email.telegramChatId).toEqual({ value: '42', source: 'ui' });

    build({ env: { APP_SECRET: TEST_SECRET }, findPhoneChat: async () => null });
    const none = await post('/email/phone-chat');
    expect(none.statusCode).toBe(409);
    expect(none.json()).toEqual({ error: 'no_chat', message: 'Mande uma mensagem para o seu bot no Telegram e tente de novo.' });
  });

  it('POST /email/phone-test uses the notifier of the context with the stored token and chat', async () => {
    await settings().saveSecret('telegram_bot_token', TOKEN);
    expect((await post('/email/phone-test')).json()).toMatchObject({ error: 'no_phone_chat' });
    await settings().update({ telegramChatId: '42' });
    const made: { token: string; chatId: string }[] = [];
    let tests = 0;
    build({
      env: { APP_SECRET: TEST_SECRET },
      phoneNotifier: (opts) => {
        made.push(opts);
        return {
          async send() {},
          async sendTest() {
            tests++;
          },
        };
      },
    });
    const res = await post('/email/phone-test');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(made).toEqual([{ token: TOKEN, chatId: '42' }]);
    expect(tests).toBe(1);
  });

  it('answers 502 with a fixed cause and never the token, in the response or the log', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    for (const method of ['error', 'log', 'warn', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation(capture);
    await settings().saveSecret('telegram_bot_token', TOKEN);
    await settings().update({ telegramChatId: '42' });
    const leak = new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`);
    build({
      env: { APP_SECRET: TEST_SECRET },
      phoneNotifier: () => ({
        async send() {},
        async sendTest() {
          throw leak;
        },
      }),
    });
    const test = await post('/email/phone-test');
    expect(test.statusCode).toBe(502);
    expect(test.json()).toEqual({ error: 'phone_failed', message: 'Não foi possível falar com o Telegram agora.' });
    build({
      env: { APP_SECRET: TEST_SECRET },
      findPhoneChat: async () => {
        throw new PhoneAlertError('token');
      },
    });
    const chat = await post('/email/phone-chat');
    expect(chat.statusCode).toBe(502);
    expect(chat.json()).toMatchObject({ error: 'phone_failed', message: expect.stringContaining('recusou o token') });
    for (const text of [test.body, chat.body, ...lines]) expect(text).not.toContain(TOKEN);
  });

  it('limits how often the chat lookup and the test reach Telegram', async () => {
    await settings().saveSecret('telegram_bot_token', TOKEN);
    expect((await post('/email/phone-chat')).statusCode).toBe(200);
    const second = await post('/email/phone-test');
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: 'rate_limited', message: expect.stringContaining('Aguarde') });
    expect(second.headers['retry-after']).toBe('5');
  });

  it('the fake notifier of the tests writes the test text to phone.json', async () => {
    const file = join(fakeMailDir(TEST_DATA_DIR), 'phone.json');
    await rm(file, { force: true });
    await settings().saveSecret('telegram_bot_token', TOKEN);
    expect((await post('/email/phone-chat')).json()).toEqual({ chatId: FAKE_TELEGRAM_CHAT_ID });
    build();
    expect((await post('/email/phone-test')).statusCode).toBe(200);
    expect(await readFile(file, 'utf8')).toContain('Teste do kanban-vagas');
    await rm(file, { force: true });
  });
});
