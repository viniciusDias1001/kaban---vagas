import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_TELEGRAM_CHAT_ID, findPhoneChatFor, phoneNotifierFor } from './factory';
import {
  PHONE_TEST_TEXT, PhoneAlertError, createFakeNotifier, createTelegramNotifier, findTelegramChatId, phoneAlertText,
} from './notify';

const TOKEN = '123:ABC';

describe('phoneAlertText', () => {
  it('says only the kind and the company', () => {
    expect(phoneAlertText({ kind: 'interview', company: 'Acme' })).toBe('Convite de entrevista: Acme');
    expect(phoneAlertText({ kind: 'offer', company: null })).toBe('Oferta');
    expect(phoneAlertText({ kind: 'offer', company: 'Globex' })).toBe('Oferta: Globex');
    expect(phoneAlertText({ kind: 'interview', company: '  ' })).toBe('Convite de entrevista');
  });
});

describe('createTelegramNotifier', () => {
  it('calls the Telegram send endpoint with the chat and the text', async () => {
    const calls: [string, RequestInit][] = [];
    const n = createTelegramNotifier({
      token: TOKEN, chatId: '42',
      fetch: async (u, i) => {
        calls.push([String(u), i!]);
        return new Response('{"ok":true}');
      },
    });
    await n.send({ kind: 'interview', company: 'Acme' });
    expect(calls[0][0]).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
    expect(calls[0][1].method).toBe('POST');
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ chat_id: '42', text: 'Convite de entrevista: Acme' });
  });

  it('sends the fixed test text', async () => {
    const bodies: unknown[] = [];
    const n = createTelegramNotifier({
      token: TOKEN, chatId: '42',
      fetch: async (_u, i) => {
        bodies.push(JSON.parse(String(i!.body)));
        return new Response('{"ok":true}');
      },
    });
    await n.sendTest();
    expect(bodies).toEqual([{ chat_id: '42', text: PHONE_TEST_TEXT }]);
    expect(PHONE_TEST_TEXT).toBe('Teste do kanban-vagas');
  });

  it('fails without leaking the token', async () => {
    const n = createTelegramNotifier({
      token: TOKEN, chatId: '42',
      fetch: async () => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 }),
    });
    await expect(n.send({ kind: 'offer', company: 'Acme' })).rejects.toThrow(/Telegram/);
    await n.send({ kind: 'offer', company: 'Acme' }).catch((e) => expect(String(e.message)).not.toContain('123:ABC'));
  });

  it('turns every failure into a fixed sentence, never the URL nor the original error', async () => {
    const cases: [() => Promise<Response>, PhoneAlertError['reason']][] = [
      [async () => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 }), 'token'],
      [async () => new Response('{"ok":false,"description":"Not Found"}', { status: 404 }), 'token'],
      [async () => new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 }), 'chat'],
      [async () => new Response('{"ok":false,"description":"Forbidden: bot was blocked by the user"}', { status: 403 }), 'blocked'],
      [async () => new Response('{"ok":false,"description":"Too Many Requests"}', { status: 429 }), 'other'],
      [async () => new Response('not json', { status: 200 }), 'other'],
      [async () => { throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`); }, 'unreachable'],
    ];
    for (const [fetch, reason] of cases) {
      const n = createTelegramNotifier({ token: TOKEN, chatId: '42', fetch });
      const error = await n.send({ kind: 'offer', company: 'Acme' }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(PhoneAlertError);
      const e = error as PhoneAlertError;
      expect(e.reason).toBe(reason);
      expect(e.message).toMatch(/Telegram/);
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).not.toContain('api.telegram.org');
      expect(e.cause).toBeUndefined();
      expect(e.stack ?? '').not.toContain(TOKEN);
    }
  });
});

describe('findTelegramChatId', () => {
  it('finds the chat of the latest private message, or none', async () => {
    const updates = { ok: true, result: [{ message: { chat: { id: 7, type: 'private' } } }, { message: { chat: { id: 42, type: 'private' } } }] };
    expect(await findTelegramChatId({ token: TOKEN, fetch: async () => new Response(JSON.stringify(updates)) })).toBe('42');
    expect(await findTelegramChatId({ token: TOKEN, fetch: async () => new Response('{"ok":true,"result":[]}') })).toBeNull();
  });

  it('asks the updates endpoint and skips groups and updates without a message', async () => {
    const urls: string[] = [];
    const updates = {
      ok: true,
      result: [
        { message: { chat: { id: 7, type: 'private' } } },
        { message: { chat: { id: -100, type: 'group' } } },
        { my_chat_member: { chat: { id: 9, type: 'private' } } },
      ],
    };
    const fetch = async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response(JSON.stringify(updates));
    };
    expect(await findTelegramChatId({ token: TOKEN, fetch })).toBe('7');
    expect(urls).toEqual(['https://api.telegram.org/bot123:ABC/getUpdates']);
  });

  it('fails without leaking the token', async () => {
    const error = await findTelegramChatId({
      token: TOKEN, fetch: async () => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 }),
    }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(PhoneAlertError);
    expect((error as Error).message).toMatch(/Telegram/);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe('fake notifier', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('appends one line per message to phone.json', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kv-phone-'));
    const n = createFakeNotifier(dir);
    await n.send({ kind: 'interview', company: 'Acme' });
    await n.sendTest();
    const lines = (await readFile(join(dir, 'phone.json'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { text: string });
    expect(lines.map((l) => l.text)).toEqual(['Convite de entrevista: Acme', 'Teste do kanban-vagas']);
  });

  it('is what FAKE_MAIL=1 gives, with a fixed chat and no network', async () => {
    dir = await mkdtemp(join(tmpdir(), 'kv-phone-'));
    await phoneNotifierFor({ FAKE_MAIL: '1' }, dir, { token: TOKEN, chatId: '42' }).send({ kind: 'offer', company: 'Globex' });
    const text = await readFile(join(dir, 'fake-mail', 'phone.json'), 'utf8');
    expect(text).toContain('Oferta: Globex');
    expect(text).not.toContain(TOKEN);
    expect(await findPhoneChatFor({ FAKE_MAIL: '1' }, TOKEN)).toBe(FAKE_TELEGRAM_CHAT_ID);
  });
});
