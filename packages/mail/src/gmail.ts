import type { Readable } from 'node:stream';
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type ImapFlowOptions, type ListResponse, type SearchObject } from 'imapflow';
import { createTransport } from 'nodemailer';
import { MAIL_LIMITS } from '@kv/shared';
import { clipBody, htmlToText, pickTextPart, stripNul, syntheticMessageId, threadKeyFromHeaders } from './text';
import { MailAuthError, MailFolderError, MailTransientError, type Mailbox, type OutgoingMail, type RawMail } from './types';

export const GMAIL = { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 } as const;

/** Tempo limite de conexão, saudação e de cada comando (inatividade do socket), no IMAP e no SMTP. */
export const TIMEOUT_MS = 30_000;
/** Teto de bytes da parte de texto pedida ao servidor. */
export const BODY_MAX_BYTES = 4 * MAIL_LIMITS.bodyChars;

export const AUTH_FAILED_TEXT = 'O Gmail recusou o login. Confira o endereço e a senha de app.';
export const TRANSIENT_TEXT = 'Não foi possível falar com o Gmail agora.';
export const FOLDERS_HIDDEN_TEXT = "Ative 'Mostrar em IMAP' para 'Todos os e-mails' e 'Enviados' nas configurações do Gmail (Marcadores).";

/**
 * O que se pede de cada mensagem: envelope, estrutura MIME, id do fio e só estes cabeçalhos.
 * O imapflow pede cabeçalhos e partes sempre com `BODY.PEEK`, que não marca a mensagem como lida.
 * Nunca `source` (a mensagem inteira) nem `bodyParts` aqui: o texto vem depois, só a parte escolhida.
 */
export const HEAD_QUERY: FetchQueryObject & { headers: string[] } = {
  uid: true,
  envelope: true,
  bodyStructure: true,
  threadId: true,
  internalDate: true,
  headers: ['reply-to', 'in-reply-to', 'references', 'auto-submitted', 'list-id', 'list-unsubscribe', 'precedence'],
};

type Creds = { address: string; password: string };

/** Traduz um erro do imapflow ou do nodemailer: login recusado -> MailAuthError; o resto -> MailTransientError. A mensagem nunca leva a senha. */
export function toMailError(e: unknown): MailAuthError | MailTransientError {
  if (e instanceof MailAuthError || e instanceof MailTransientError) return e;
  const x = (e && typeof e === 'object' ? e : {}) as {
    authenticationFailed?: unknown; code?: unknown; responseCode?: unknown; serverResponseCode?: unknown;
  };
  const refused =
    x.authenticationFailed === true || // imapflow: AuthenticationFailure
    x.code === 'EAUTH' || // nodemailer: login SMTP recusado
    x.responseCode === 535 || // SMTP 535: usuário e senha não aceitos
    (typeof x.serverResponseCode === 'string' && x.serverResponseCode.toUpperCase() === 'AUTHENTICATIONFAILED');
  // Texto fixo e sem `cause`: o erro original pode trazer o comando enviado, com a senha.
  return refused ? new MailAuthError(AUTH_FAILED_TEXT) : new MailTransientError(TRANSIENT_TEXT);
}

export function imapOptions(creds: Creds): ImapFlowOptions {
  return {
    host: GMAIL.imapHost,
    port: GMAIL.imapPort,
    secure: true,
    auth: { user: creds.address, pass: creds.password },
    // Sem log: o log do imapflow repete comandos e respostas do servidor.
    logger: false,
    // Sem IDLE: a leitura é por rodada, e nada roda na conexão entre uma chamada e outra.
    disableAutoIdle: true,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  };
}

export function smtpOptions(creds: Creds) {
  return {
    host: GMAIL.smtpHost,
    port: GMAIL.smtpPort,
    secure: true,
    auth: { user: creds.address, pass: creds.password },
    logger: false,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    dnsTimeout: TIMEOUT_MS,
    // A mensagem é montada pelo app: nenhum anexo vem de arquivo ou de endereço.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** Corpo só em texto puro, no fio do e-mail recebido, com um anexo no máximo. */
export function sendOptions(mail: OutgoingMail) {
  return {
    messageId: mail.messageId,
    from: { name: mail.fromName, address: mail.from },
    // Objeto, não texto: o nodemailer não reinterpreta o endereço (vírgula, aspas, sinais de menor e maior).
    to: { name: '', address: mail.to },
    subject: mail.subject,
    text: mail.text,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    attachments: mail.attachment ? [{ filename: mail.attachment.fileName, content: mail.attachment.content }] : [],
  };
}

/** Continua depois do último UID; com UIDVALIDITY diferente ou sem ponto lido, recomeça pela data (o SEARCH SINCE do IMAP conta o dia inteiro). */
export function inboxSearch(
  opts: Parameters<Mailbox['fetchInbox']>[0],
  uidValidity: number,
): { restart: boolean; query: SearchObject } {
  if (opts.afterUid === null || opts.uidValidity !== uidValidity) return { restart: true, query: { since: new Date(opts.since) } };
  return { restart: false, query: { uid: `${opts.afterUid + 1}:*` } };
}

/** As mais antigas primeiro, até `limit`. `n:*` sempre devolve a última mensagem, mesmo com UID menor que n: ela sai aqui. */
export function pickNewUids(uids: number[], afterUid: number | null, limit: number): number[] {
  return uids.filter((u) => afterUid === null || u > afterUid).sort((a, b) => a - b).slice(0, limit);
}

/** Pasta pela marca de uso especial que o servidor informa; nunca pelo nome, que muda com o idioma da conta. */
export function findSpecialUse(
  list: Pick<ListResponse, 'path' | 'flags' | 'specialUse' | 'specialUseSource'>[],
  use: '\\All' | '\\Sent',
): string | null {
  const mark = use.toLowerCase();
  const found = list.find(
    (e) => [...e.flags].some((f) => f.toLowerCase() === mark) || (e.specialUse === use && e.specialUseSource === 'extension'),
  );
  return found ? found.path : null;
}

/** A pasta de uso especial; sem ela (escondida do IMAP nas configurações do Gmail), `MailFolderError` dizendo como mostrá-la. */
export function requireSpecialUse(
  list: Pick<ListResponse, 'path' | 'flags' | 'specialUse' | 'specialUseSource'>[],
  use: '\\All' | '\\Sent',
): string {
  const path = findSpecialUse(list, use);
  if (!path) throw new MailFolderError(FOLDERS_HIDDEN_TEXT);
  return path;
}

/** Id de fio do Gmail (X-GM-THRID, só dígitos); outra chave é um Message-ID, procurado nos cabeçalhos. */
export function threadSearch(threadKey: string): SearchObject {
  if (/^\d+$/.test(threadKey)) return { threadId: threadKey };
  return { or: [{ header: { 'message-id': threadKey } }, { header: { references: threadKey } }] };
}

/** Cabeçalhos pedidos por HEADER.FIELDS: nome em minúsculas, linhas dobradas desfeitas; vale a primeira ocorrência. */
export function parseHeaderBlock(block: Buffer | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!block) return out;
  for (const line of stripNul(block.toString('utf8')).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(colon + 1).trim());
  }
  return out;
}

/** Ids sem os sinais de menor e maior. */
function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
  return bracketed.length ? bracketed : value.split(/\s+/).filter(Boolean);
}

function epochMs(value: Date | string | undefined): number | null {
  if (value === undefined) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Endereços não vazios do Reply-To, em minúsculas, separados por `, `; nenhum: null. */
function replyToAddresses(list: { address?: string }[] | undefined): string | null {
  const addresses = (list ?? []).map((a) => (a.address ?? '').trim().toLowerCase()).filter(Boolean);
  return addresses.length ? addresses.join(', ') : null;
}

/** O envelope com todo texto sem NUL (o Postgres recusa 0x00 em texto); datas e o resto ficam como vieram. */
function withoutNul<T>(value: T): T {
  if (typeof value === 'string') return stripNul(value) as T;
  if (Array.isArray(value)) return value.map(withoutNul) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNul(v)])) as T;
  }
  return value;
}

/** Uma mensagem buscada com HEAD_QUERY, mais o texto já extraído, vira RawMail. */
export function toRawMail(
  msg: Pick<FetchMessageObject, 'uid' | 'threadId' | 'envelope' | 'headers' | 'internalDate'>,
  text: string,
  uidValidity: number,
): RawMail {
  const env = withoutNul(msg.envelope ?? {});
  const h = parseHeaderBlock(msg.headers);
  const messageId = messageIds(env.messageId)[0] ?? syntheticMessageId(uidValidity, msg.uid);
  const inReplyTo = messageIds(env.inReplyTo)[0] ?? messageIds(h.get('in-reply-to'))[0] ?? null;
  const references = messageIds(h.get('references'));
  const from = env.from?.[0];
  const autoSubmitted = h.get('auto-submitted');
  return {
    uid: msg.uid,
    messageId,
    threadKey: msg.threadId || threadKeyFromHeaders({ messageId, inReplyTo, references }),
    from: { address: (from?.address ?? '').toLowerCase(), name: from?.name ?? '' },
    to: [...(env.to ?? []), ...(env.cc ?? [])].map((a) => (a.address ?? '').toLowerCase()).filter(Boolean),
    // O ENVELOPE repete o From em Reply-To quando o cabeçalho não existe: vale só o cabeçalho de verdade.
    // Grupo vazio vem com endereço vazio e não conta; vários endereços ficam todos, para não parecer um só.
    replyTo: h.has('reply-to') ? replyToAddresses(env.replyTo) : null,
    subject: env.subject ?? '',
    // A data em que o Gmail recebeu (INTERNALDATE), que o remetente não escolhe; o cabeçalho Date só na falta dela.
    date: epochMs(msg.internalDate) ?? epochMs(env.date) ?? 0,
    inReplyTo,
    references,
    autoSubmitted: autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== 'no',
    listId: h.has('list-id'),
    bulk: h.has('list-unsubscribe') || ['bulk', 'list', 'junk'].includes((h.get('precedence') ?? '').trim().toLowerCase()),
    text,
  };
}

/** Lê o fluxo até `maxBytes` e para de puxar o resto. */
export async function readCapped(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buf);
    size += buf.length;
    if (size >= maxBytes) break; // sair do for-await destrói o fluxo
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/**
 * Gmail por IMAP (só leitura) e SMTP. Pastas abertas com EXAMINE (`readOnly: true`) e conferidas como
 * READ-ONLY pelo servidor; nada usa STORE, MOVE, COPY, EXPUNGE, APPEND nem CLOSE. A única escrita é o envio.
 */
class GmailMailbox implements Mailbox {
  private imap: ImapFlow | null = null;
  private smtp: ReturnType<typeof createTransport> | null = null;

  constructor(private readonly creds: Creds) {}

  private connecting: Promise<ImapFlow> | null = null;

  /** Uma conexão por caixa; chamadas ao mesmo tempo esperam a mesma abertura. */
  private client(): Promise<ImapFlow> {
    if (this.imap?.usable) return Promise.resolve(this.imap);
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<ImapFlow> {
    this.dropImap();
    const client = new ImapFlow(imapOptions(this.creds));
    // A falha chega pela promessa do comando; sem ouvinte, o evento 'error' derrubaria o processo.
    client.on('error', () => {});
    this.imap = client;
    await client.connect();
    return client;
  }

  private dropImap(): void {
    try {
      this.imap?.close();
    } catch { /* já fechada */ }
    this.imap = null;
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.dropImap();
      throw toMailError(e);
    }
  }

  private async inFolder<T>(path: string, fn: (client: ImapFlow, uidValidity: number) => Promise<T>): Promise<T> {
    const client = await this.client();
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      // EXAMINE tem de voltar READ-ONLY; se não voltou, não se lê nada.
      if (!mailbox || mailbox.readOnly !== true) throw new MailTransientError(TRANSIENT_TEXT);
      return await fn(client, Number(mailbox.uidValidity));
    } finally {
      lock.release();
    }
  }

  private async specialFolder(use: '\\All' | '\\Sent'): Promise<string> {
    return requireSpecialUse(await (await this.client()).list(), use);
  }

  private async search(client: ImapFlow, query: SearchObject): Promise<number[]> {
    const found = await client.search(query, { uid: true });
    if (!Array.isArray(found)) throw new MailTransientError(TRANSIENT_TEXT);
    return found;
  }

  /** Cabeçalhos e estrutura primeiro; depois só a parte de texto escolhida, com teto de bytes. Anexos nunca são pedidos. */
  private async fetchMails(client: ImapFlow, uids: number[], uidValidity: number): Promise<RawMail[]> {
    if (!uids.length) return [];
    const heads = await client.fetchAll(uids, HEAD_QUERY, { uid: true });
    const mails: RawMail[] = [];
    for (const msg of heads) {
      const choice = pickTextPart(msg.bodyStructure);
      let text = '';
      if (choice) {
        const download = await client.download(String(msg.uid), choice.part, { uid: true, maxBytes: BODY_MAX_BYTES, chunkSize: BODY_MAX_BYTES });
        if (download.content) {
          const raw = await readCapped(download.content, BODY_MAX_BYTES);
          text = choice.html ? htmlToText(raw) : raw;
        }
      }
      mails.push(toRawMail(msg, clipBody(text), uidValidity));
    }
    return mails;
  }

  /** Login e as duas pastas de que a leitura precisa ("Todos os e-mails" para o fio, "Enviados" para conferir um envio). */
  check(): Promise<void> {
    return this.run(async () => {
      const list = await (await this.client()).list();
      requireSpecialUse(list, '\\All');
      requireSpecialUse(list, '\\Sent');
    });
  }

  fetchInbox(opts: { uidValidity: number | null; afterUid: number | null; since: number; limit: number }) {
    return this.run(() =>
      this.inFolder('INBOX', async (client, uidValidity) => {
        const { restart, query } = inboxSearch(opts, uidValidity);
        const uids = pickNewUids(await this.search(client, query), restart ? null : opts.afterUid, opts.limit);
        const mails = await this.fetchMails(client, uids, uidValidity);
        return { uidValidity, mails: mails.sort((a, b) => a.uid - b.uid) };
      }),
    );
  }

  fetchInboxByUid(uid: number): Promise<RawMail | null> {
    return this.run(() =>
      this.inFolder('INBOX', async (client, uidValidity) => (await this.fetchMails(client, [uid], uidValidity))[0] ?? null),
    );
  }

  fetchThread(threadKey: string): Promise<RawMail[]> {
    return this.run(async () => {
      const all = await this.specialFolder('\\All');
      return this.inFolder(all, async (client, uidValidity) => {
        const mails = await this.fetchMails(client, await this.search(client, threadSearch(threadKey)), uidValidity);
        return mails.sort((a, b) => a.date - b.date || a.uid - b.uid);
      });
    });
  }

  sentExists(messageId: string): Promise<boolean> {
    return this.run(async () => {
      const sent = await this.specialFolder('\\Sent');
      return this.inFolder(sent, async (client) => (await this.search(client, { header: { 'message-id': messageId } })).length > 0);
    });
  }

  send(mail: OutgoingMail): Promise<void> {
    return this.run(async () => {
      this.smtp ??= createTransport(smtpOptions(this.creds));
      await this.smtp.sendMail(sendOptions(mail));
    });
  }

  async close(): Promise<void> {
    const imap = this.imap;
    this.imap = null;
    try {
      if (imap?.usable) await imap.logout();
      else imap?.close();
    } catch { /* fechar nunca lança */ }
    try {
      this.smtp?.close();
    } catch { /* idem */ }
    this.smtp = null;
  }
}

export function createGmailMailbox(creds: Creds): Mailbox {
  return new GmailMailbox(creds);
}
