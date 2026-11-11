import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import type { Connector } from '@kv/connectors';
import { closeDb, enqueueRuns, jobEvents, jobs, runs, searchProfiles, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import type { NormalizedJob } from '@kv/shared';
import { executeRun, insertNewJobs } from './runner';

const job = (n: number, over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  source: 'a', externalId: String(n), url: `https://example.com/${n}`, title: `React Developer ${n}`,
  company: 'Acme', location: 'Remoto', country: 'BR', remote: true, stacks: ['react'], description: '',
  postedAt: Date.now(), ...over,
});

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function setup(sources: string[]) {
  const [profile] = await db
    .insert(searchProfiles)
    .values({
      name: 'P', stacks: ['react'], levels: [], maxAgeDays: 7, regions: [], sources, active: true, createdAt: 1,
    })
    .returning();
  await enqueueRuns(db, profile, 'manual');
  return { profile };
}

const runFor = async (source: string) => (await db.select().from(runs).where(eq(runs.source, source)))[0];

describe('executeRun', () => {
  it('inserts new jobs into descobertas and records the run', async () => {
    await setup(['a']);
    const a: Connector = { id: 'a', name: 'A', search: async () => [job(1), job(2)] };
    const before = Date.now();
    await executeRun(db, (await runFor('a')).id, [a]);

    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.column === 'descobertas')).toBe(true);
    expect(await db.select().from(jobEvents)).toHaveLength(2);
    const run = await runFor('a');
    expect(run).toMatchObject({ status: 'ok', found: 2, inserted: 2 });
    expect(run.startedAt).toBeGreaterThanOrEqual(before);
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt!);
  });

  it('does not insert the same job twice', async () => {
    const { profile } = await setup(['a']);
    const a: Connector = { id: 'a', name: 'A', search: async () => [job(1)] };
    await executeRun(db, (await runFor('a')).id, [a]);
    await enqueueRuns(db, profile, 'manual');
    const [second] = await db.select().from(runs).where(eq(runs.status, 'queued'));
    await executeRun(db, second.id, [a]);

    expect(await db.select().from(jobs)).toHaveLength(1);
    expect(await db.select().from(jobEvents)).toHaveLength(1);
    const [after] = await db.select().from(runs).where(eq(runs.id, second.id));
    expect(after).toMatchObject({ found: 1, inserted: 0 });
  });

  it('treats the same company and title from another source as duplicate', async () => {
    await setup(['a', 'b']);
    const a: Connector = { id: 'a', name: 'A', search: async () => [job(1)] };
    const b: Connector = {
      id: 'b', name: 'B',
      search: async () => [job(1, { source: 'b', url: 'https://other.com/x' })],
    };
    await executeRun(db, (await runFor('a')).id, [a, b]);
    await executeRun(db, (await runFor('b')).id, [a, b]);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it('applies the profile filters', async () => {
    await setup(['a']);
    const a: Connector = {
      id: 'a', name: 'A',
      search: async () => [job(1), job(2, { title: 'Python Developer', stacks: ['python'] })],
    };
    await executeRun(db, (await runFor('a')).id, [a]);
    expect((await db.select().from(jobs)).map((j) => j.title)).toEqual(['React Developer 1']);
  });

  it('records an error without throwing, leaving other sources unaffected', async () => {
    await setup(['a', 'b']);
    const a: Connector = { id: 'a', name: 'A', search: async () => { throw new Error('boom'); } };
    const b: Connector = { id: 'b', name: 'B', search: async () => [job(1, { source: 'b' })] };
    await executeRun(db, (await runFor('a')).id, [a, b], { retries: 0 });
    await executeRun(db, (await runFor('b')).id, [a, b]);

    expect(await runFor('a')).toMatchObject({ status: 'error', error: 'boom' });
    expect((await runFor('b')).status).toBe('ok');
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it('retries once before failing', async () => {
    await setup(['a']);
    let calls = 0;
    const a: Connector = {
      id: 'a', name: 'A',
      search: async () => { calls++; if (calls === 1) throw new Error('flaky'); return [job(1)]; },
    };
    await executeRun(db, (await runFor('a')).id, [a]);
    expect(calls).toBe(2);
    expect((await runFor('a')).status).toBe('ok');
  });

  it('fails a run whose connector exceeds the timeout', async () => {
    await setup(['a']);
    const a: Connector = { id: 'a', name: 'A', search: () => new Promise(() => {}) };
    await executeRun(db, (await runFor('a')).id, [a], { timeoutMs: 20, retries: 0 });
    expect((await runFor('a')).status).toBe('error');
    expect((await runFor('a')).error).toContain('timeout');
  });

  it('records an error for an unknown connector and ignores an unknown run id', async () => {
    await setup(['a']);
    await executeRun(db, (await runFor('a')).id, []);
    expect(await runFor('a')).toMatchObject({ status: 'error', error: 'conector desconhecido: a' });
    await expect(executeRun(db, 999, [])).resolves.toBeUndefined();
  });
});

describe('insertNewJobs', () => {
  it('writes one event per inserted job, with level, epoch timestamps and ordered positions', async () => {
    const { profile } = await setup(['a']);
    const postedAt = Date.now() - 1000;
    const before = Date.now();
    const found = [job(1, { title: 'React Developer Senior', postedAt }), job(2)];
    expect(await insertNewJobs(db, profile.id, found)).toBe(2);

    const rows = await db.select().from(jobs).orderBy(asc(jobs.position));
    expect(rows.map((r) => r.url)).toEqual(['https://example.com/1', 'https://example.com/2']);
    expect(rows[0]).toMatchObject({ level: 'senior', postedAt, profileId: profile.id, column: 'descobertas' });
    expect(rows[0].discoveredAt).toBeGreaterThanOrEqual(before);
    expect(rows[1].position - rows[0].position).toBe(1);
    expect(rows[0].position).toBeLessThan(0);

    const events = await db.select().from(jobEvents);
    expect(events.map((e) => e.jobId).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(events.every((e) => e.fromColumn === null && e.toColumn === 'descobertas' && e.actor === 'sistema')).toBe(true);
  });

  it('skips a url already on the board even when the dedup hash differs, without writing an event', async () => {
    const { profile } = await setup(['a']);
    expect(await insertNewJobs(db, profile.id, [job(1)])).toBe(1);
    const sameUrl = job(1, { title: 'React Developer (renamed)' });
    expect(await insertNewJobs(db, profile.id, [sameUrl, job(2)])).toBe(1);
    expect(await db.select().from(jobs)).toHaveLength(2);
    expect(await db.select().from(jobEvents)).toHaveLength(2);
  });

  it('drops duplicates inside the same batch (same hash or same url)', async () => {
    const { profile } = await setup(['a']);
    const batch = [
      job(1),
      job(1, { url: 'https://other.com/same-hash' }),
      job(3, { url: 'https://example.com/shared' }),
      job(4, { url: 'https://example.com/shared' }),
    ];
    expect(await insertNewJobs(db, profile.id, batch)).toBe(2);
    expect(await db.select().from(jobEvents)).toHaveLength(2);
  });

  it('inserts each job once when two runs race on the same results', async () => {
    const { profile } = await setup(['a']);
    const batch = [job(1), job(2), job(3)];
    const counts = await Promise.all([insertNewJobs(db, profile.id, batch), insertNewJobs(db, profile.id, batch)]);
    expect(counts[0] + counts[1]).toBe(3);
    expect(await db.select().from(jobs)).toHaveLength(3);
    expect(await db.select().from(jobEvents)).toHaveLength(3);
  });

  it('keeps one job when two sources race with the same vacancy under different urls', async () => {
    const { profile } = await setup(['a']);
    const counts = await Promise.all([
      insertNewJobs(db, profile.id, [job(1)]),
      insertNewJobs(db, profile.id, [job(1, { source: 'b', url: 'https://other.com/x' })]),
    ]);
    expect(counts[0] + counts[1]).toBe(1);
    expect(await db.select().from(jobs)).toHaveLength(1);
    expect(await db.select().from(jobEvents)).toHaveLength(1);
  });

  it('handles more jobs than one insert chunk', async () => {
    const { profile } = await setup(['a']);
    const many = Array.from({ length: 1201 }, (_, i) => job(i));
    expect(await insertNewJobs(db, profile.id, many)).toBe(1201);
    expect(await insertNewJobs(db, profile.id, many)).toBe(0);
    expect(await db.select({ id: jobEvents.id }).from(jobEvents)).toHaveLength(1201);
  });

  it('returns 0 for an empty list', async () => {
    const { profile } = await setup(['a']);
    expect(await insertNewJobs(db, profile.id, [])).toBe(0);
  });
});
