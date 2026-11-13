import { AiError, createProvider } from '@kv/ai';
import { applyDataDir } from '@kv/apply';
import { MAIL_QUEUE_LOCK, getMailAccount, raiseAlert, updateMailAccount, type Db } from '@kv/db';
import { mailboxFor, type Mailbox } from '@kv/mail';
import type { SettingsService } from '@kv/settings';
import { emailAvailability } from '@kv/shared';
import { sql } from 'drizzle-orm';
import { createMailAi } from './ai-calls';
import { createMailQueue, type MailQueue } from './queue';
import { resumeForReply } from './send';

/** Com a caixa falsa, a leitura roda a cada 3 s (o e2e não espera 3 min). */
const FAKE_POLL_MS = 3_000;

/** O lock de sessão da fila de e-mail, enquanto este processo o segura. */
export interface MailLock { release(): Promise<void> }

/**
 * Tenta pegar o lock de sessão `MAIL_QUEUE_LOCK`. Com o postgres-js, numa conexão reservada que fica com o processo (o
 * pool não fecha uma conexão reservada por tempo de vida, e o lock vive com a conexão); com o PGlite (uma conexão só), na
 * própria conexão. Null: outro processo o segura.
 */
export async function takeMailLock(db: Db): Promise<MailLock | null> {
  type Reserved = { unsafe(query: string): Promise<{ ok: boolean }[]>; release(): void };
  const client = (db as { $client?: { reserve?: () => Promise<Reserved> } }).$client;
  if (typeof client?.reserve === 'function') {
    const conn = await client.reserve();
    try {
      const [row] = await conn.unsafe(`select pg_try_advisory_lock(${MAIL_QUEUE_LOCK}) as ok`);
      if (row?.ok !== true) {
        conn.release();
        return null;
      }
    } catch (e) {
      conn.release();
      throw e;
    }
    return {
      async release() {
        try {
          await conn.unsafe(`select pg_advisory_unlock(${MAIL_QUEUE_LOCK}) as ok`);
        } finally {
          conn.release();
        }
      },
    };
  }
  const result = (await db.execute(sql`select pg_try_advisory_lock(${sql.raw(String(MAIL_QUEUE_LOCK))}) as ok`)) as unknown as
    | { ok: boolean }[]
    | { rows: { ok: boolean }[] };
  const rows = Array.isArray(result) ? result : result.rows;
  if (rows[0]?.ok !== true) return null;
  return {
    async release() {
      await db.execute(sql`select pg_advisory_unlock(${sql.raw(String(MAIL_QUEUE_LOCK))})`);
    },
  };
}

/**
 * A caixa da linha conectada, com a senha do cofre. Sem linha: null. Com a linha e sem senha legível (não gravada, sem
 * `APP_SECRET`, ou indecifrável): grava a causa em `error` e abre o alerta `mailbox_error`, uma vez por causa, e devolve null.
 */
export async function openOwnerMailbox(
  db: Db, settings: SettingsService, env: NodeJS.ProcessEnv, dataDir: string, now: () => number = Date.now,
): Promise<Mailbox | null> {
  const account = await getMailAccount(db);
  if (!account) return null;
  const secret = await settings.readSecret('mail_password');
  if (secret.value === null) {
    const reason = secret.code === 'none'
      ? 'A senha da caixa não está gravada. Conecte a caixa de novo.'
      : `A senha da caixa não pôde ser lida. ${secret.problem}`;
    if (account.error !== reason) {
      await updateMailAccount(db, { error: reason });
      await raiseAlert(db, { kind: 'mailbox_error', payload: { reason } }, now());
    }
    return null;
  }
  return mailboxFor(env, dataDir, { address: account.address, password: secret.value });
}

/**
 * Monta a fila do processo: caixa de `mailboxFor(env, applyDataDir(env), …)` com a senha do cofre, IA das configurações
 * (lida a cada pergunta); com `FAKE_MAIL=1`, leitura a cada 3 s. Só um worker por banco faz trabalho de e-mail: a fila
 * tenta o lock de sessão `MAIL_QUEUE_LOCK` a cada verificação até consegui-lo, e sem ele não faz nada. `close` o devolve.
 */
export function createMailRuntime(
  db: Db,
  settings: SettingsService,
  opts: { env?: NodeJS.ProcessEnv; log?: (msg: string) => void; lock?: (db: Db) => Promise<MailLock | null> } = {},
): MailQueue & { close(): Promise<void> } {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const dataDir = applyDataDir(env);
  const host = emailAvailability(env);
  const now = Date.now;
  const ai = createMailAi({
    db, now, log,
    ai: async () => {
      const { config, problem } = await settings.aiConfig();
      if (!config) throw new AiError('config', problem ?? 'IA não configurada');
      return { provider: createProvider(config), config };
    },
  });
  const queue = createMailQueue({
    db, settings, ai, now, log,
    openMailbox: () => openOwnerMailbox(db, settings, env, dataDir, now),
    availability: () => host,
    resume: resumeForReply(db),
    ...(env.FAKE_MAIL === '1' ? { pollMs: FAKE_POLL_MS } : {}),
  });

  const take = opts.lock ?? takeMailLock;
  let lock: MailLock | null = null;
  let taking: Promise<boolean> | null = null;
  let warned = false;
  let closed = false;

  /** O lock, pego agora ou antes. Sem ele, avisa uma vez e a fila não faz nada. */
  function haveLock(): Promise<boolean> {
    if (lock) return Promise.resolve(true);
    if (closed) return Promise.resolve(false);
    taking ??= take(db)
      .then((got) => {
        lock = got;
        if (!got && !warned) log('[mail] outro worker já cuida do e-mail neste banco; esta fila fica parada enquanto ele estiver no ar');
        if (got && warned) log('[mail] o outro worker saiu; esta fila assume o e-mail');
        warned ||= !got;
        return got !== null;
      })
      .finally(() => {
        taking = null;
      });
    return taking;
  }

  return {
    async tick() {
      if (!(await haveLock())) return { read: false, worked: false };
      return queue.tick();
    },
    async recoverInterrupted() {
      if (await haveLock()) await queue.recoverInterrupted();
    },
    idle: () => queue.idle(),
    async close() {
      closed = true;
      await taking?.catch(() => false);
      const held = lock;
      lock = null;
      if (held) await held.release();
    },
  };
}
