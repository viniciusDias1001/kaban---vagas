/**
 * Aviso no celular: convite de entrevista e oferta mandam uma mensagem por um bot do Telegram que o dono cria. Só sai da
 * máquina o tipo do aviso e o nome da empresa. Outro canal (ligação, por exemplo) entra trocando só a implementação de
 * `PhoneNotifier`.
 *
 * O token do bot vai dentro da URL de toda chamada ao Telegram: nenhum erro daqui leva a URL, o erro original do `fetch`
 * nem o corpo da resposta. As falhas viram frases fixas (`PhoneAlertError`).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface PhoneAlert { kind: 'interview' | 'offer'; company: string | null }

/** O texto de "Enviar teste". */
export const PHONE_TEST_TEXT = 'Teste do kanban-vagas';

const KIND_TEXT: Record<PhoneAlert['kind'], string> = { interview: 'Convite de entrevista', offer: 'Oferta' };

/** "Convite de entrevista: Acme" ou "Oferta: Acme"; sem empresa, só "Convite de entrevista" ou "Oferta". Nada mais sai da máquina. */
export function phoneAlertText(alert: PhoneAlert): string {
  const company = alert.company?.trim();
  return company ? `${KIND_TEXT[alert.kind]}: ${company}` : KIND_TEXT[alert.kind];
}

export interface PhoneNotifier {
  send(alert: PhoneAlert, signal?: AbortSignal): Promise<void>;
  /** Manda `PHONE_TEST_TEXT` ao mesmo destino ("Enviar teste" da tela). */
  sendTest(signal?: AbortSignal): Promise<void>;
}

const PHONE_ERROR_TEXT = {
  token: 'O Telegram recusou o token do bot. Confira o token que o BotFather mostrou e grave de novo.',
  chat: 'O Telegram não achou o seu chat. Mande uma mensagem para o seu bot e aperte Achar meu chat de novo.',
  blocked: 'O seu bot está bloqueado no Telegram. Desbloqueie o bot e tente de novo.',
  unreachable: 'Não foi possível falar com o Telegram agora.',
  other: 'O Telegram não aceitou a mensagem agora. Tente de novo mais tarde.',
} as const;

/** Por que o Telegram não deu certo. A mensagem é uma frase fixa em pt-BR, sem token, URL nem nada do que o servidor respondeu. */
export class PhoneAlertError extends Error {
  override name = 'PhoneAlertError';
  constructor(readonly reason: keyof typeof PHONE_ERROR_TEXT) {
    super(PHONE_ERROR_TEXT[reason]);
  }
}

/** Teto de cada chamada ao Telegram: o worker e a API não ficam parados esperando. */
const TIMEOUT_MS = 10_000;
const API = 'https://api.telegram.org';

type Fetch = typeof fetch;

/**
 * Uma chamada ao método `method` da API de bots. Devolve o `result` de uma resposta `ok`; qualquer outra coisa lança
 * `PhoneAlertError` com uma frase fixa.
 */
async function callTelegram(
  opts: { token: string; fetch?: Fetch }, method: string, body: object | null, signal?: AbortSignal,
): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  type Reply = { ok?: unknown; description?: unknown; result?: unknown } | null;
  let parsed: Reply;
  let status: number;
  try {
    const res = await doFetch(`${API}/bot${opts.token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    status = res.status;
    parsed = (await res.json().catch(() => null)) as Reply;
  } catch {
    // O erro do fetch pode trazer a URL, e a URL traz o token: ele é descartado.
    throw new PhoneAlertError('unreachable');
  }
  if (status >= 200 && status < 300 && parsed?.ok === true) return parsed.result;
  const description = typeof parsed?.description === 'string' ? parsed.description.toLowerCase() : '';
  if (status === 401 || status === 404) throw new PhoneAlertError('token');
  if (status === 403) throw new PhoneAlertError('blocked');
  if (status === 400 && description.includes('chat not found')) throw new PhoneAlertError('chat');
  throw new PhoneAlertError('other');
}

/** POST https://api.telegram.org/bot<token>/sendMessage com { chat_id, text }. Erro sem repetir o token na mensagem. */
export function createTelegramNotifier(opts: { token: string; chatId: string; fetch?: Fetch }): PhoneNotifier {
  const sendText = async (text: string, signal?: AbortSignal) => {
    await callTelegram(opts, 'sendMessage', { chat_id: opts.chatId, text }, signal);
  };
  return {
    send: (alert, signal) => sendText(phoneAlertText(alert), signal),
    sendTest: (signal) => sendText(PHONE_TEST_TEXT, signal),
  };
}

/** Com FAKE_MAIL=1: acrescenta uma linha em `<dir>/phone.json`. */
export function createFakeNotifier(dir: string): PhoneNotifier {
  const append = async (text: string) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'phone.json'), `${JSON.stringify({ at: Date.now(), text })}\n`);
  };
  return {
    send: (alert) => append(phoneAlertText(alert)),
    sendTest: () => append(PHONE_TEST_TEXT),
  };
}

interface TelegramUpdate { message?: { chat?: { id?: unknown; type?: unknown } } }

/** GET https://api.telegram.org/bot<token>/getUpdates: o id do chat privado da mensagem mais recente, ou null se ninguém escreveu ao bot. */
export async function findTelegramChatId(opts: { token: string; fetch?: Fetch }): Promise<string | null> {
  const result = await callTelegram(opts, 'getUpdates', null);
  const updates = Array.isArray(result) ? (result as TelegramUpdate[]) : [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i]?.message?.chat;
    if (chat?.type === 'private' && (typeof chat.id === 'number' || typeof chat.id === 'string')) return String(chat.id);
  }
  return null;
}
