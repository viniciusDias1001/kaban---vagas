import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { alerts, openAlerts, raiseAlert, type Db } from '@kv/db';
import { resetTestDb } from '@kv/db/testing';
import { PhoneAlertError, type PhoneAlert, type PhoneNotifier } from '@kv/mail';
import { notifyNext } from './phone';
import { DAY, MAIL_NOW, mailTestBed } from './test-helpers';

type Bed = Awaited<ReturnType<typeof mailTestBed>>;
let bed: Bed;
let db: Db;
let sent: PhoneAlert[];
let logs: string[];
let deps: Parameters<typeof notifyNext>[0];

/** Guarda o que seria enviado; nenhuma rede. */
const recorder: PhoneNotifier = {
  async send(alert) {
    sent.push(alert);
  },
  async sendTest() {},
};

beforeAll(async () => {
  bed = await mailTestBed();
  db = bed.db;
});
afterAll(() => bed.close());
beforeEach(async () => {
  await resetTestDb(db);
  sent = [];
  logs = [];
  deps = { db, notifier: recorder, now: () => MAIL_NOW, log: (m) => logs.push(m) };
  const acme = await bed.seedAppliedJob('Acme', 'Engenheira de Software', MAIL_NOW - 10 * DAY);
  await raiseAlert(db, { kind: 'interview', jobId: acme }, MAIL_NOW - 1000);
  // Os outros tipos de alerta ficam só no app.
  await raiseAlert(db, { kind: 'mailbox_error', payload: { reason: 'O Gmail recusou o login.' } }, MAIL_NOW - 900);
  await raiseAlert(db, { kind: 'backfill_summary', payload: { total: 3 } }, MAIL_NOW - 800);
});

describe('notifyNext', () => {
  it('sends one phone alert per interview or offer alert', async () => {
    expect(await notifyNext(deps)).toBe(true);
    expect(await notifyNext(deps)).toBe(false);
    expect(sent).toEqual([{ kind: 'interview', company: 'Acme' }]);
    const [row] = await db.select().from(alerts).where(eq(alerts.kind, 'interview'));
    expect(row).toMatchObject({ phoneSentAt: MAIL_NOW, phoneAttempts: 1, resolvedAt: null });
  });

  it('sends the oldest first, offers too, and without a company only the kind', async () => {
    await raiseAlert(db, { kind: 'offer' }, MAIL_NOW - 500);
    expect(await notifyNext(deps)).toBe(true);
    expect(await notifyNext(deps)).toBe(true);
    expect(await notifyNext(deps)).toBe(false);
    expect(sent).toEqual([{ kind: 'interview', company: 'Acme' }, { kind: 'offer', company: null }]);
  });

  it('gives up after three failed attempts and keeps the alert in the app', async () => {
    let calls = 0;
    const failing: PhoneNotifier = {
      async send() {
        calls++;
        throw new PhoneAlertError('unreachable');
      },
      async sendTest() {},
    };
    const broken = { ...deps, notifier: failing };
    for (let i = 0; i < 3; i++) expect(await notifyNext(broken)).toBe(true);
    expect(await notifyNext(broken)).toBe(false);
    expect(calls).toBe(3);
    expect((await openAlerts(db)).map((a) => a.kind)).toContain('interview');
    expect(logs.filter((l) => l.includes('Não foi possível falar com o Telegram agora.'))).toHaveLength(3);
  });

  it('sends at most three times when the send works but recording it fails', async () => {
    await db.execute(sql.raw(`create or replace function kv_test_fail() returns trigger language plpgsql as $$
      begin if new.phone_sent_at is not null then raise exception 'falha simulada ao gravar o envio'; end if; return new; end $$`));
    await db.execute(sql.raw('create trigger kv_test_fail before update on alerts for each row execute function kv_test_fail()'));
    try {
      for (let round = 0; round < 3; round++) await expect(notifyNext(deps)).rejects.toThrow();
      for (let round = 0; round < 3; round++) expect(await notifyNext(deps)).toBe(false);
    } finally {
      await db.execute(sql.raw('drop trigger kv_test_fail on alerts'));
    }
    expect(sent).toEqual([1, 2, 3].map(() => ({ kind: 'interview', company: 'Acme' })));
    const [row] = await db.select().from(alerts).where(eq(alerts.kind, 'interview'));
    expect(row).toMatchObject({ phoneSentAt: null, phoneAttempts: 3 });
  });

  it('never logs the text of an unexpected error', async () => {
    const leaky: PhoneNotifier = {
      async send() {
        throw new Error('https://api.telegram.org/bot123:ABC/sendMessage');
      },
      async sendTest() {},
    };
    expect(await notifyNext({ ...deps, notifier: leaky })).toBe(true);
    expect(logs.join('\n')).not.toContain('123:ABC');
  });

  it('does nothing with the channel off', async () => expect(await notifyNext({ ...deps, notifier: null })).toBe(false));
});
