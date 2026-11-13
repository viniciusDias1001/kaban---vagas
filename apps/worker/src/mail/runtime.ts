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

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Com a caixa falsa, a leitura roda a cada 3 s (o e2e não espera 3 min). */
const FAKE_POLL_MS = 3_000;

/** O lock de sessão da fila de e-mail, enquanto este processo o segura. */
export interface MailLock {
  /**
   * A sessão que pegou o lock ainda o segura? Uma queda do banco ou da conexão o solta no servidor sem avisar este
   * processo; a conferência falha (lança) ou devolve false.
   */
  alive(): Promise<boolean>;
  release(): Promise<void>;
}

const TRY_LOCK = `select pg_try_advisory_lock(${MAIL_QUEUE_LOCK}) as ok`;
const UNLOCK = `select pg_advisory_unlock(${MAIL_QUEUE_LOCK}) as ok`;
/** Quantos locks `MAIL_QUEUE_LOCK` a sessão atual segura (0 ou mais; lock de sessão é reentrante). */
const HELD = `select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${MAIL_QUEUE_LOCK} `
  + `and granted and pid = pg_backend_pid()`;

/**
 * Tenta pegar o lock de sessão `MAIL_QUEUE_LOCK`. Com o postgres-js, numa conexão reservada que fica com o processo (o
 * pool não fecha uma conexão reservada por tempo de vida, e o lock vive com a conexão); com o PGlite (uma conexão só), na
 * própria conexão. Null: outro processo o segura.
 */
export async function takeMailLock(db: Db): Promise<MailLock | null> {
  type Reserved = { unsafe(query: string): Promise<Record<string, unknown>[]>; release(): void };
  const client = (db as { $client?: { reserve?: () => Promise<Reserved> } }).$client;
  if (typeof client?.reserve === 'function') {
    const conn = await client.reserve();
    try {
      const [row] = await conn.unsafe(TRY_LOCK);
      if (row?.ok !== true) {
        conn.release();
        return null;
      }
    } catch (e) {
      conn.release();
      throw e;
    }
    return {
      async alive() {
        const [row] = await conn.unsafe(HELD);
        return Number(row?.n ?? 0) > 0;
      },
      async release() {
        try {
          await conn.unsafe(UNLOCK);
        } finally {
          conn.release();
        }
      },
    };
  }
  const run = async (query: string): Promise<Record<string, unknown>[]> => {
    const result = (await db.execute(sql.raw(query))) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
    return Array.isArray(result) ? result : result.rows;
  };
  if ((await run(TRY_LOCK))[0]?.ok !== true) return null;
  return {
    async alive() {
      return Number((await run(HELD))[0]?.n ?? 0) > 0;
    },
    async release() {
      await run(UNLOCK);
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
 * (lida a cada pergunta); com `FAKE_MAIL=1`, leitura a cada 3 s. Só um worker por banco faz trabalho de e-mail: a cada
 * verificação a fila confere (ou pede) o lock de sessão `MAIL_QUEUE_LOCK`, e sem ele não faz nada. A primeira verificação
 * com o lock confere os envios interrompidos antes de qualquer outra coisa. `close` devolve o lock.
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
  let warned = false;
  let closed = false;
  let stopped = false;
  /** Os envios interrompidos já foram conferidos neste processo (a primeira verificação com o lock faz isso). */
  let recovered = false;
  /** A verificação em andamento, para `idle` esperá-la e para duas não rodarem juntas. */
  let pendingTick: Promise<{ read: boolean; worked: boolean }> | null = null;
  const nothing = () => ({ read: false, worked: false });

  /**
   * O lock, conferido a cada verificação: a sessão que o pegou ainda o segura? Uma queda do banco ou da conexão o solta no
   * servidor sem avisar este processo, e outro worker pode pegá-lo; então a conexão é devolvida e o lock é pedido de novo.
   * Sem ele, avisa uma vez e a fila não faz nada.
   */
  async function haveLock(): Promise<boolean> {
    if (lock) {
      const held = await lock.alive().catch(() => false);
      if (held) return true;
      const lost = lock;
      lock = null;
      warned = false;
      log('[mail] esta fila perdeu o lock do e-mail (o banco ou a conexão caiu); pedindo-o de novo');
      await lost.release().catch(() => {});
    }
    if (closed) return false;
    const got = await take(db);
    lock = got;
    if (!got && !warned) log('[mail] outro worker já cuida do e-mail neste banco; esta fila fica parada enquanto ele estiver no ar');
    if (got && warned) log('[mail] o outro worker saiu; esta fila assume o e-mail');
    warned = !got;
    return got !== null;
  }

  /** Lock e, na primeira vez, os envios interrompidos; cada falha vai para o log e a próxima verificação tenta de novo. */
  async function check(): Promise<{ read: boolean; worked: boolean }> {
    try {
      if (!(await haveLock()) || stopped) return nothing();
    } catch (e) {
      log(`[mail] erro ao pedir o lock do e-mail: ${errorText(e)}`);
      return nothing();
    }
    if (!recovered) {
      try {
        await queue.recoverInterrupted();
        recovered = true;
      } catch (e) {
        log(`[mail] erro ao recuperar envios interrompidos: ${errorText(e)}`);
        return nothing();
      }
    }
    return queue.tick();
  }

  return {
    tick() {
      if (stopped || pendingTick) return Promise.resolve(nothing());
      const tick = check().finally(() => {
        if (pendingTick === tick) pendingTick = null;
      });
      pendingTick = tick;
      return tick;
    },
    async recoverInterrupted() {
      if (!(await haveLock())) return;
      await queue.recoverInterrupted();
      recovered = true;
    },
    stop() {
      stopped = true;
      queue.stop();
    },
    async idle() {
      while (pendingTick) await pendingTick.catch(() => {});
      await queue.idle();
    },
    async close() {
      closed = true;
      await pendingTick?.catch(() => {});
      const held = lock;
      lock = null;
      if (held) await held.release();
    },
  };
}
