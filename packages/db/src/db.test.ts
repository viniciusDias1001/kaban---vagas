import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import {
  assertDbReady, closeDb, createDb, enqueueRuns, jobEvents, jobs, migrate, runs, searchProfiles, type Db,
} from './index';
import * as schema from './schema';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function seedProfile(sources: string[] = ['gupy', 'remotive']) {
  const [row] = await db
    .insert(searchProfiles)
    .values({
      name: 'React', stacks: ['react', 'node'], levels: ['pleno'], maxAgeDays: 7,
      regions: ['remoto'], sources, active: true, createdAt: 1,
    })
    .returning();
  return row;
}

function insertRun(profileId: number, source: string, status: 'queued' | 'running' | 'ok' | 'error') {
  return db.insert(runs).values({ profileId, source, trigger: 'manual', status, createdAt: Date.now() });
}

function jobValues(url: string, over: Partial<typeof jobs.$inferInsert> = {}): typeof jobs.$inferInsert {
  return {
    source: 'gupy', externalId: url, url, title: 'Dev', company: 'ACME', location: 'Remoto',
    country: 'BR', remote: true, level: 'pleno', stacks: ['react'], description: '',
    postedAt: null, discoveredAt: 1, dedupHash: url, profileId: null, position: 1, ...over,
  };
}

const rowsOf = async <T>(query: ReturnType<typeof sql>): Promise<T[]> => {
  const res = (await db.execute(query)) as unknown as { rows: T[] };
  return res.rows;
};

describe('createDb', () => {
  it('throws a clear error when DATABASE_URL is missing', () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => createDb()).toThrow(/DATABASE_URL não definida.*\.env\.example/);
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });
});

describe('migrations', () => {
  it('creates every table with row level security enabled', async () => {
    const rows = await rowsOf<{ relname: string; relrowsecurity: boolean }>(
      sql`select relname, relrowsecurity from pg_class
          where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(rows).toEqual(
      [
        'ai_keys', 'ai_tasks', 'ai_usage', 'job_ai', 'job_events', 'jobs', 'profiles', 'resumes', 'runs', 'search_profiles',
        'settings', 'tailored_resumes',
      ].map((relname) => ({ relname, relrowsecurity: true })),
    );
  });

  it('creates the indexes, including the partial unique one', async () => {
    const rows = await rowsOf<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`,
    );
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.jobs_url_idx).toMatch(/UNIQUE INDEX/);
    expect(defs.jobs_dedup_idx).toBeDefined();
    expect(defs.job_events_job_idx).toBeDefined();
    expect(defs.runs_status_idx).toBeDefined();
    expect(defs.runs_pending_idx).toMatch(/UNIQUE INDEX.*\(profile_id, source\) WHERE/);
  });

  it('stores time columns as timestamptz and position as double precision', async () => {
    const rows = await rowsOf<{ table_name: string; column_name: string; data_type: string }>(
      sql`select table_name, column_name, data_type from information_schema.columns
          where table_schema = 'public' and (column_name like '%\_at' or column_name = 'position')`,
    );
    const position = rows.find((r) => r.column_name === 'position');
    expect(position?.data_type).toBe('double precision');
    const times = rows.filter((r) => r.column_name !== 'position');
    expect(times.map((r) => `${r.table_name}.${r.column_name}`).sort()).toEqual([
      'ai_keys.updated_at', 'ai_tasks.created_at', 'ai_tasks.finished_at', 'ai_tasks.started_at', 'ai_usage.created_at',
      'job_ai.tier1_at', 'job_ai.tier2_at', 'job_events.created_at', 'jobs.description_fetched_at', 'jobs.discovered_at',
      'jobs.posted_at', 'profiles.updated_at', 'resumes.uploaded_at', 'runs.created_at', 'runs.finished_at',
      'runs.started_at', 'search_profiles.created_at', 'settings.updated_at', 'tailored_resumes.created_at',
      'tailored_resumes.edited_at',
    ]);
    expect(times.every((r) => r.data_type === 'timestamp with time zone')).toBe(true);
  });

  it('migrate() is idempotent', async () => {
    await seedProfile();
    await migrate(db);
    await migrate(db);
    expect(await db.select().from(searchProfiles)).toHaveLength(1);
  });
});

describe('assertDbReady', () => {
  it('passes on a migrated database', async () => {
    await expect(assertDbReady(db)).resolves.toBeUndefined();
  });

  // Banco vazio (sem migrar). A instância do PGlite sobe num hook, e não dentro do teste: o start-up é lento
  // sob CPU disputada e estourava o timeout de 5 s do teste; hooks têm `hookTimeout` (60 s, vitest.config.ts).
  describe('with an unmigrated database', () => {
    let empty: Db;
    beforeAll(async () => {
      empty = drizzle(new PGlite(), { schema });
      await empty.execute(sql`select 1`); // força o start-up já no hook
    });
    afterAll(() => closeDb(empty));

    it('asks for pnpm db:migrate when the tables are missing', async () => {
      await expect(assertDbReady(empty)).rejects.toThrow(/search_profiles.*rode pnpm db:migrate/);
    });
  });

  it('reports an unreachable database', async () => {
    // porta 9 (discard): nada escuta ali; nenhuma conexão real é aberta com sucesso.
    const dead = createDb('postgres://postgres:postgres@127.0.0.1:9/kanban');
    try {
      const error = await assertDbReady(dead).then(() => null, (e: Error) => e);
      expect(error?.message).toMatch(/Não foi possível conectar ao Postgres \(.*ECONNREFUSED.*\)\. Confira DATABASE_URL/);
      expect(error?.message).not.toMatch(/Failed query/);
    } finally {
      await closeDb(dead);
    }
  });
});

describe('column types', () => {
  it('round-trips text[] and boolean columns', async () => {
    const profile = await seedProfile();
    const [read] = await db.select().from(searchProfiles).where(eq(searchProfiles.id, profile.id));
    expect(read.stacks).toEqual(['react', 'node']);
    expect(read.levels).toEqual(['pleno']);
    expect(read.sources).toEqual(['gupy', 'remotive']);
    expect(read.active).toBe(true);
    expect(read.id).toBeTypeOf('number');
  });

  it('round-trips empty arrays and strings that need quoting', async () => {
    const [row] = await db
      .insert(searchProfiles)
      .values({
        name: 'x', stacks: ['c#', 'node, js', 'a "b"', '{x}'], levels: [], maxAgeDays: 1, regions: [],
        sources: ['a'], createdAt: 1,
      })
      .returning();
    expect(row.stacks).toEqual(['c#', 'node, js', 'a "b"', '{x}']);
    expect(row.levels).toEqual([]);
  });

  it('exposes timestamps as epoch milliseconds, including null', async () => {
    const now = Date.now();
    const [inserted] = await db
      .insert(jobs)
      .values(jobValues('https://x.test/t', { postedAt: now, discoveredAt: 1 }))
      .returning();
    expect(inserted.postedAt).toBe(now);
    expect(inserted.discoveredAt).toBe(1);

    await db.insert(jobs).values(jobValues('https://x.test/n', { postedAt: null, discoveredAt: now }));
    const [nulled] = await db.select().from(jobs).where(isNull(jobs.postedAt));
    expect(nulled.postedAt).toBeNull();
    expect(nulled.discoveredAt).toBe(now);

    const [raw] = await rowsOf<{ ms: string | number }>(
      sql`select (extract(epoch from posted_at) * 1000)::bigint as ms from jobs where url = 'https://x.test/t'`,
    );
    expect(Number(raw.ms)).toBe(now);
  });

  it('updates a timestamp to a number and back to null', async () => {
    const profile = await seedProfile();
    const [run] = await insertRun(profile.id, 'gupy', 'ok').returning();
    expect(run.finishedAt).toBeNull();
    const [done] = await db.update(runs).set({ finishedAt: 1234567890123 }).where(eq(runs.id, run.id)).returning();
    expect(done.finishedAt).toBe(1234567890123);
    const [cleared] = await db.update(runs).set({ finishedAt: null }).where(eq(runs.id, run.id)).returning();
    expect(cleared.finishedAt).toBeNull();
  });

  it('compares timestamps against epoch milliseconds', async () => {
    const profile = await seedProfile();
    const HOUR = 3_600_000;
    const now = 10 * HOUR;
    await db.insert(runs).values({
      profileId: profile.id, source: 'gupy', trigger: 'cron', status: 'ok', createdAt: now, finishedAt: now - 60_000,
    });
    const recent = (at: number) =>
      db.select({ id: runs.id }).from(runs).where(and(eq(runs.status, 'ok'), gt(runs.finishedAt, at - HOUR)));
    expect(await recent(now)).toHaveLength(1);
    expect(await recent(now + HOUR)).toHaveLength(0);
    expect(await db.select().from(runs).where(lt(runs.finishedAt, now))).toHaveLength(1);
    expect(await db.select().from(runs).where(lt(runs.finishedAt, now - 60_000))).toHaveLength(0);
  });

  it('keeps large negative positions exact and sorted', async () => {
    const now = Date.now();
    await db.insert(jobs).values([
      jobValues('https://x.test/2', { position: -now + 2 }),
      jobValues('https://x.test/0', { position: -now }),
      jobValues('https://x.test/1', { position: -now + 1 }),
      jobValues('https://x.test/half', { position: 0.5 }),
    ]);
    const rows = await db.select({ url: jobs.url, position: jobs.position }).from(jobs).orderBy(asc(jobs.position));
    expect(rows.map((r) => r.position)).toEqual([-now, -now + 1, -now + 2, 0.5]);
    expect(rows[0].url).toBe('https://x.test/0');
  });
});

describe('jobs', () => {
  it('rejects a duplicate url, and onConflictDoNothing returns no row for it', async () => {
    await db.insert(jobs).values(jobValues('https://x.test/1'));
    await expect(db.insert(jobs).values(jobValues('https://x.test/1'))).rejects.toThrow();
    const skipped = await db
      .insert(jobs)
      .values(jobValues('https://x.test/1'))
      .onConflictDoNothing({ target: jobs.url })
      .returning({ id: jobs.id });
    expect(skipped).toEqual([]);
    await db.insert(jobs).values(jobValues('https://x.test/2'));
    expect(await db.select().from(jobs)).toHaveLength(2);
  });

  it('defaults column, needsHuman and notes', async () => {
    const [row] = await db.insert(jobs).values(jobValues('https://x.test/d')).returning();
    expect(row).toMatchObject({ column: 'descobertas', needsHuman: false, notes: '', appliedBy: null });
  });
});

describe('foreign keys', () => {
  it('deleting a profile keeps its jobs (profileId becomes null) and removes its runs', async () => {
    const profile = await seedProfile();
    const [job] = await db.insert(jobs).values(jobValues('https://x.test/1', { profileId: profile.id })).returning();
    await db.insert(jobEvents).values({ jobId: job.id, fromColumn: null, toColumn: 'descobertas', actor: 'sistema', createdAt: 1 });
    await insertRun(profile.id, 'gupy', 'ok');

    await db.delete(searchProfiles).where(eq(searchProfiles.id, profile.id));

    const remaining = await db.select().from(jobs);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].profileId).toBeNull();
    expect(await db.select().from(jobEvents)).toHaveLength(1);
    expect(await db.select().from(runs)).toHaveLength(0);
  });

  it('deleting a job removes its events', async () => {
    const [job] = await db.insert(jobs).values(jobValues('https://x.test/1')).returning();
    await db.insert(jobEvents).values({ jobId: job.id, fromColumn: null, toColumn: 'descobertas', actor: 'sistema', createdAt: 1 });
    await db.delete(jobs).where(eq(jobs.id, job.id));
    expect(await db.select().from(jobEvents)).toHaveLength(0);
  });

  it('rejects rows pointing at a profile or job that does not exist', async () => {
    await expect(insertRun(999, 'gupy', 'queued')).rejects.toThrow();
    await expect(db.insert(jobs).values(jobValues('https://x.test/1', { profileId: 999 }))).rejects.toThrow();
    await expect(
      db.insert(jobEvents).values({ jobId: 999, fromColumn: null, toColumn: 'descobertas', actor: 'sistema', createdAt: 1 }),
    ).rejects.toThrow();
  });
});

describe('enqueueRuns', () => {
  it('queues one run per source and skips sources already pending', async () => {
    const profile = await seedProfile();
    expect(await enqueueRuns(db, profile, 'manual')).toBe(2);
    expect(await enqueueRuns(db, profile, 'cron')).toBe(0);
    const rows = await db.select().from(runs);
    expect(rows.map((r) => r.source).sort()).toEqual(['gupy', 'remotive']);
    expect(rows.every((r) => r.status === 'queued' && r.trigger === 'manual')).toBe(true);
  });

  it('de-duplicates repeated sources', async () => {
    const profile = await seedProfile(['gupy', 'gupy', 'remotive']);
    expect(await enqueueRuns(db, profile, 'manual')).toBe(2);
    expect(await db.select().from(runs)).toHaveLength(2);
  });

  it('returns a number', async () => {
    const profile = await seedProfile();
    expect(await enqueueRuns(db, profile, 'manual')).toBeTypeOf('number');
  });

  it('enqueues again a source whose previous run is ok or error', async () => {
    const profile = await seedProfile();
    await insertRun(profile.id, 'gupy', 'ok');
    await insertRun(profile.id, 'remotive', 'error');
    expect(await enqueueRuns(db, profile, 'manual')).toBe(2);
    const queued = await db.select().from(runs).where(eq(runs.status, 'queued'));
    expect(queued.map((r) => r.source).sort()).toEqual(['gupy', 'remotive']);
  });

  it('does not let pending runs of profile A block profile B', async () => {
    const a = await seedProfile();
    const b = await seedProfile();
    expect(await enqueueRuns(db, a, 'manual')).toBe(2);
    expect(await enqueueRuns(db, b, 'manual')).toBe(2);
    expect(await db.select().from(runs).where(eq(runs.profileId, b.id))).toHaveLength(2);
  });

  it('queues only the free source when another is pending and returns 1', async () => {
    const profile = await seedProfile();
    await insertRun(profile.id, 'gupy', 'running');
    expect(await enqueueRuns(db, profile, 'manual')).toBe(1);
    const queued = await db.select().from(runs).where(eq(runs.status, 'queued'));
    expect(queued.map((r) => r.source)).toEqual(['remotive']);
  });

  it('unique index forbids two pending runs for the same (profile, source)', async () => {
    const profile = await seedProfile();
    await insertRun(profile.id, 'gupy', 'queued');
    await expect(insertRun(profile.id, 'gupy', 'queued')).rejects.toThrow();
    await expect(insertRun(profile.id, 'gupy', 'running')).rejects.toThrow();
    // runs terminados não entram no índice parcial
    await insertRun(profile.id, 'gupy', 'ok');
    await insertRun(profile.id, 'gupy', 'ok');
    expect(await db.select().from(runs)).toHaveLength(3);
  });

  it('is idempotent when two callers enqueue at the same time', async () => {
    const profile = await seedProfile();
    const counts = await Promise.all([enqueueRuns(db, profile, 'manual'), enqueueRuns(db, profile, 'cron')]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(await db.select().from(runs)).toHaveLength(2);
  });
});
