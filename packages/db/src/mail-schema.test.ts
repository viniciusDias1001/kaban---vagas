import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, type Db } from './index';
import { alerts, jobEvents, jobs, mailAccount, mailMessages, mailReplies } from './schema';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function seedJob() {
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: 'a1', url: 'https://example.com/1', title: 'Dev', company: 'Acme', location: 'Remoto', country: 'BR',
      remote: true, level: null, stacks: [], description: '', postedAt: null, discoveredAt: 1, dedupHash: 'a1', profileId: null, position: 1,
    })
    .returning();
  return row;
}

const message = (messageId: string, jobId: number | null = null): typeof mailMessages.$inferInsert => ({
  messageId, threadKey: messageId, direction: 'in', fromAddress: 'rh@example.com', fromName: 'RH Acme', toAddress: 'maria@example.com',
  subject: 'Sua candidatura', body: 'Olá', sentAt: 1000, createdAt: 1000, jobId,
});

const reply = (messageId: number): typeof mailReplies.$inferInsert => ({
  messageId, origin: 'facts', toAddress: 'rh@example.com', subject: 'Re: Sua candidatura', body: 'Olá', state: 'rascunho', createdAt: 1000,
});

describe('mail tables', () => {
  it('keeps one mailbox row', async () => {
    await db.insert(mailAccount).values({ id: 1, address: 'maria@example.com', connectedAt: 1000 });
    await expect(db.insert(mailAccount).values({ id: 2, address: 'outra@example.com', connectedAt: 1000 })).rejects.toThrow();
  });

  it('keeps one row per Message-ID and one reply per message', async () => {
    const [m] = await db.insert(mailMessages).values(message('<a@x>')).returning();
    await expect(db.insert(mailMessages).values(message('<a@x>'))).rejects.toThrow();
    await db.insert(mailReplies).values(reply(m.id));
    await expect(db.insert(mailReplies).values(reply(m.id))).rejects.toThrow();
  });

  it('reads bigint columns as numbers and applies the defaults', async () => {
    await db.insert(mailAccount).values({ id: 1, address: 'maria@example.com', connectedAt: 1000, uidValidity: 3_000_000_000, lastUid: 42 });
    const [acc] = await db.select().from(mailAccount);
    expect(acc.uidValidity).toBe(3_000_000_000);
    expect(acc.backfillDone).toBe(false);
    const [m] = await db.insert(mailMessages).values({ ...message('<b@x>'), uid: 7 }).returning();
    expect(m.uid).toBe(7);
    expect(m.refs).toEqual([]);
    expect(m.requests).toEqual([]);
    expect(m.forceClassify).toBe(false);
  });

  it('removes replies and alerts with their message, and keeps the card event', async () => {
    const job = await seedJob();
    const [m] = await db.insert(mailMessages).values(message('<c@x>', job.id)).returning();
    const [r] = await db.insert(mailReplies).values(reply(m.id)).returning();
    await db.insert(alerts).values([
      { kind: 'draft', jobId: job.id, mailMessageId: m.id, createdAt: 1000 },
      { kind: 'draft', jobId: job.id, replyId: r.id, createdAt: 1000 },
    ]);
    await db.insert(jobEvents).values({ jobId: job.id, fromColumn: null, toColumn: 'aplicada', actor: 'email', mailMessageId: m.id, createdAt: 1000 });

    await db.delete(mailMessages).where(eq(mailMessages.id, m.id));

    expect(await db.select().from(mailReplies)).toHaveLength(0);
    expect(await db.select().from(alerts)).toHaveLength(0);
    const events = await db.select().from(jobEvents);
    expect(events).toHaveLength(1);
    expect(events[0].mailMessageId).toBeNull();
  });

  it('refuses an AI reply approved by auto', async () => {
    const [m] = await db.insert(mailMessages).values(message('<d@x>')).returning();
    await expect(db.insert(mailReplies).values({ ...reply(m.id), origin: 'ai', state: 'aprovada', approvedBy: 'auto' })).rejects.toThrow();
    // Aprovada pelo dono, ou montada pelo código e aprovada por `auto`: aceitas.
    const [ok] = await db.insert(mailReplies).values({ ...reply(m.id), origin: 'ai', state: 'aprovada', approvedBy: 'owner' }).returning();
    await expect(db.update(mailReplies).set({ approvedBy: 'auto' }).where(eq(mailReplies.id, ok.id))).rejects.toThrow();
    const [n] = await db.insert(mailMessages).values(message('<e@x>')).returning();
    await db.insert(mailReplies).values({ ...reply(n.id), state: 'aprovada', approvedBy: 'auto' });
  });

  it('indexes the card events by their mail', async () => {
    const result = await db.execute(sql`select indexname from pg_indexes where tablename = 'job_events'`);
    const rows = ((result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])) as { indexname: string }[];
    expect(rows.map((r) => r.indexname)).toContain('job_events_mail_message_idx');
  });

  it('has row level security on every new table', async () => {
    const names = ['alerts', 'app_secrets', 'mail_account', 'mail_ignored', 'mail_messages', 'mail_replies'];
    const result = await db.execute(
      sql`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    const rows = ((result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])) as { relname: string; relrowsecurity: boolean }[];
    for (const name of names) expect(rows.find((r) => r.relname === name)?.relrowsecurity, name).toBe(true);
  });
});
