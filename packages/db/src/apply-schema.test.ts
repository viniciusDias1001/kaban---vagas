import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, type Db } from './index';
import { applicationEvents, applications, applyAnswers, applyCommands, jobs } from './schema';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function seedJob(url = 'https://example.com/1') {
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: url, url, title: 'Dev', company: 'ACME', location: 'Remoto', country: 'BR',
      remote: true, level: null, stacks: [], description: '', postedAt: null, discoveredAt: 1, dedupHash: url,
      profileId: null, position: 1,
    })
    .returning();
  return row;
}

const row = (jobId: number, extra: Partial<typeof applications.$inferInsert> = {}): typeof applications.$inferInsert => ({
  jobId, site: 'linkedin', status: 'queued', trigger: 'manual', mode: 'dry_run', createdAt: 1, ...extra,
});

describe('apply tables', () => {
  it('allows one application per job', async () => {
    const job = await seedJob();
    await db.insert(applications).values(row(job.id));
    await expect(db.insert(applications).values(row(job.id))).rejects.toThrow();
  });

  it('deletes applications and their events with the job', async () => {
    const job = await seedJob();
    const [app] = await db.insert(applications).values(row(job.id)).returning();
    await db.insert(applicationEvents).values({ applicationId: app.id, status: 'queued', message: null, createdAt: 1 });
    await db.delete(jobs).where(eq(jobs.id, job.id));
    expect(await db.select().from(applications)).toHaveLength(0);
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
  });

  it('refuses a sent PDF above 2 MiB', async () => {
    const a = await seedJob('https://example.com/a');
    const b = await seedJob('https://example.com/b');
    await db.insert(applications).values(row(a.id, { resumePdf: Buffer.alloc(2 * 1024 * 1024) }));
    await expect(db.insert(applications).values(row(b.id, { resumePdf: Buffer.alloc(2 * 1024 * 1024 + 1) }))).rejects.toThrow();
  });

  it('allows one pending command per kind and site', async () => {
    const cmd = { kind: 'open_login', site: 'linkedin' as const, createdAt: 1 };
    const [first] = await db.insert(applyCommands).values({ ...cmd, status: 'queued' }).returning();
    await expect(db.insert(applyCommands).values({ ...cmd, status: 'queued' })).rejects.toThrow();
    await db.update(applyCommands).set({ status: 'ok' }).where(eq(applyCommands.id, first.id));
    await db.insert(applyCommands).values({ ...cmd, status: 'queued' });
  });

  it('keeps answer keys unique per country, and lets keyless rows repeat', async () => {
    const base = { question: 'q', normalized: 'q', answer: '', kind: 'text' as const, createdAt: 1, updatedAt: 1 };
    await db.insert(applyAnswers).values({ ...base, key: 'x', country: null });
    await expect(db.insert(applyAnswers).values({ ...base, key: 'x', country: null })).rejects.toThrow();
    await db.insert(applyAnswers).values({ ...base, key: null, country: null });
    await db.insert(applyAnswers).values({ ...base, key: null, country: null });
    await db.insert(applyAnswers).values({ ...base, key: 'x', country: 'BR' });
    await db.insert(applyAnswers).values({ ...base, key: 'x', country: 'US' });
    await expect(db.insert(applyAnswers).values({ ...base, key: 'x', country: 'BR' })).rejects.toThrow();
  });

  it('has row level security on the five tables', async () => {
    const rows = await db.execute(sql`select relname, relrowsecurity from pg_class where relname in
      ('applications','application_events','apply_answers','apply_commands','apply_sites')`);
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.every((r: any) => r.relrowsecurity === true)).toBe(true);
  });
});
