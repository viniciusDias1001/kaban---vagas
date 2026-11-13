import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MAIL_QUEUE_LOCK, alerts, dismissAlert, getMailAccount, mailMessages, openAlerts, saveMailAccount, type Db } from '@kv/db';
import { resetTestDb } from '@kv/db/testing';
import { deliverFakeMail, fakeMailDir } from '@kv/mail';
import { createSettingsService, type SettingsService } from '@kv/settings';
import { createMailRuntime, openOwnerMailbox, takeMailLock } from './runtime';
import { DAY, HOUR, OWNER_ADDRESS, mailTestBed } from './test-helpers';

type Bed = Awaited<ReturnType<typeof mailTestBed>>;
let bed: Bed;
let db: Db;
let dataDir: string;
let env: NodeJS.ProcessEnv;
let settings: SettingsService;
let logs: string[];

const SECRET = 'segredo-de-teste-do-worker-com-mais-de-32-caracteres';

beforeAll(async () => {
  bed = await mailTestBed();
  db = bed.db;
});
afterAll(() => bed.close());
beforeEach(async () => {
  await resetTestDb(db);
  // O runtime usa o relógio de verdade: a caixa foi conectada agora.
  await saveMailAccount(db, OWNER_ADDRESS, Date.now());
  await bed.seedAppliedJob('Acme', 'Engenheira de Software', Date.now() - 10 * DAY);
  dataDir = await mkdtemp(join(tmpdir(), 'kv-mail-runtime-'));
  env = { FAKE_MAIL: '1', APPLY_DATA_DIR: dataDir, APP_SECRET: SECRET, HOST: '127.0.0.1' };
  settings = createSettingsService(db, { env });
  logs = [];
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function deliverJobMail(): void {
  deliverFakeMail(fakeMailDir(dataDir), {
    messageId: 'convite-1@acme.com', from: { address: 'joana@acme.com', name: 'Joana (Acme)' }, to: [OWNER_ADDRESS],
    subject: 'Sua candidatura na Acme', text: 'Queremos marcar uma entrevista.', date: Date.now() - HOUR,
  });
}

async function advisoryLocks(): Promise<number> {
  const result = (await db.execute(
    sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${sql.raw(String(MAIL_QUEUE_LOCK))}`,
  )) as unknown as { rows: { n: number }[] };
  return result.rows[0]!.n;
}

describe('createMailRuntime', () => {
  it('builds the fake mailbox with FAKE_MAIL=1 and reads the credential from the vault', async () => {
    await settings.saveSecret('mail_password', 'abcdefghijklmnop');
    deliverJobMail();
    const runtime = createMailRuntime(db, settings, { env, log: (m) => logs.push(m) });
    expect(await runtime.tick()).toEqual({ read: true, worked: false });
    await runtime.idle();
    expect((await db.select().from(mailMessages)).map((m) => m.messageId)).toEqual(['convite-1@acme.com']);
    expect(await getMailAccount(db)).toMatchObject({ error: null, paused: false });
    await runtime.close();
  });

  it('has no mailbox when the credential cannot be read', async () => {
    deliverJobMail();
    const runtime = createMailRuntime(db, settings, { env, log: (m) => logs.push(m) });
    await expect(runtime.tick()).resolves.toEqual({ read: true, worked: false });
    await runtime.idle();
    expect(await db.select().from(mailMessages)).toEqual([]);
    expect((await getMailAccount(db))!.error).toMatch(/senha da caixa não está gravada/);
    expect((await openAlerts(db)).map((a) => a.kind)).toEqual(['mailbox_error']);
    await runtime.close();
  });

  it('says why when the credential was saved under another APP_SECRET, and raises the alert once per cause', async () => {
    await settings.saveSecret('mail_password', 'abcdefghijklmnop');
    const rotated = createSettingsService(db, { env: { ...env, APP_SECRET: 'outro-segredo-de-teste-com-mais-de-32-caracteres' } });
    expect(await openOwnerMailbox(db, rotated, env, dataDir)).toBeNull();
    expect((await getMailAccount(db))!.error).toMatch(/não pôde ser lida.*decifrado/);
    const [alert] = await openAlerts(db);
    await dismissAlert(db, alert!.id);
    expect(await openOwnerMailbox(db, rotated, env, dataDir)).toBeNull();
    expect(await db.select().from(alerts)).toHaveLength(1);

    const noSecret = createSettingsService(db, { env: { ...env, APP_SECRET: undefined } });
    expect(await openOwnerMailbox(db, noSecret, env, dataDir)).toBeNull();
    expect((await getMailAccount(db))!.error).toMatch(/não pôde ser lida.*APP_SECRET/);
    expect(await db.select().from(alerts)).toHaveLength(2);
  });

  it('does nothing off a local host', async () => {
    await settings.saveSecret('mail_password', 'abcdefghijklmnop');
    deliverJobMail();
    const runtime = createMailRuntime(db, settings, { env: { ...env, HOST: '0.0.0.0' } });
    expect(await runtime.tick()).toEqual({ read: false, worked: false });
    await runtime.idle();
    expect(await db.select().from(mailMessages)).toEqual([]);
    await runtime.close();
  });

  it('holds a session advisory lock while it runs and gives it back on close', async () => {
    await settings.saveSecret('mail_password', 'abcdefghijklmnop');
    const runtime = createMailRuntime(db, settings, { env });
    expect(await advisoryLocks()).toBe(0);
    await runtime.recoverInterrupted();
    expect(await advisoryLocks()).toBe(1);
    await runtime.tick();
    await runtime.idle();
    expect(await advisoryLocks()).toBe(1); // pego uma vez só
    await runtime.close();
    expect(await advisoryLocks()).toBe(0);
  });

  it('takeMailLock answers the lock key on PGlite and lets it go', async () => {
    const lock = await takeMailLock(db);
    expect(lock).not.toBeNull();
    expect(await advisoryLocks()).toBe(1);
    await lock!.release();
    expect(await advisoryLocks()).toBe(0);
  });

  it('runs no mail work while another worker holds the lock, and takes over once it is free', async () => {
    await settings.saveSecret('mail_password', 'abcdefghijklmnop');
    deliverJobMail();
    let held = true;
    const runtime = createMailRuntime(db, settings, {
      env, log: (m) => logs.push(m), lock: async (d) => (held ? null : takeMailLock(d)),
    });
    await runtime.recoverInterrupted();
    for (let i = 0; i < 3; i++) {
      expect(await runtime.tick()).toEqual({ read: false, worked: false });
      await runtime.idle();
    }
    expect(await db.select().from(mailMessages)).toEqual([]);
    expect(logs.filter((l) => l.includes('outro worker'))).toHaveLength(1);
    held = false;
    expect(await runtime.tick()).toEqual({ read: true, worked: false });
    await runtime.idle();
    expect(await db.select().from(mailMessages)).toHaveLength(1);
    expect(logs.filter((l) => l.includes('assume o e-mail'))).toHaveLength(1);
    await runtime.close();
  });
});
