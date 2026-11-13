import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import {
  closeDb, getMailAccount, insertMailMessage, mailMessages, openAlerts, raiseAlert, saveMailAccount, saveProfile, type Db,
} from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { MailTransientError, type Mailbox } from '@kv/mail';
import { createSettingsService } from '@kv/settings';
import { TEST_SECRET, testAi } from './ai-testing';
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
});
