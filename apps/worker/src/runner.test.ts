import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Connector } from '@kv/connectors';
import { enqueueRuns, jobEvents, jobs, openDb, runs, searchProfiles, type Db } from '@kv/db';
import type { NormalizedJob } from '@kv/shared';
import { executeRun } from './runner';

const job = (n: number, over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  source: 'a', externalId: String(n), url: `https://example.com/${n}`, title: `React Developer ${n}`,
  company: 'Acme', location: 'Remoto', country: 'BR', remote: true, stacks: ['react'], description: '',
  postedAt: Date.now(), ...over,
});

function setup(sources: string[]) {
  const db = openDb(':memory:');
  const profile = db
    .insert(searchProfiles)
    .values({
      name: 'P', stacks: ['react'], levels: [], maxAgeDays: 7, regions: [], sources, active: true, createdAt: 1,
    })
    .returning()
    .get();
  enqueueRuns(db, profile, 'manual');
  return { db, profile };
}

const runFor = (db: Db, source: string) => db.select().from(runs).where(eq(runs.source, source)).get()!;

describe('executeRun', () => {
  it('inserts new jobs into descobertas and records the run', async () => {
    const { db } = setup(['a']);
    const a: Connector = { id: 'a', name: 'A', search: async () => [job(1), job(2)] };
    await executeRun(db, runFor(db, 'a').id, [a]);

    const rows = db.select().from(jobs).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.column === 'descobertas')).toBe(true);
    expect(db.select().from(jobEvents).all()).toHaveLength(2);
    expect(runFor(db, 'a')).toMatchObject({ status: 'ok', found: 2, inserted: 2 });
  });

  it('does not insert the same job twice', async () => {
    const { db, profile } = setup(['a']);
    const a: Connector = { id: 'a', name: 'A', search: async () => [job(1)] };
    await executeRun(db, runFor(db, 'a').id, [a]);
    enqueueRuns(db, profile, 'manual');
    const second = db.select().from(runs).where(eq(runs.status, 'queued')).get()!;
    await executeRun(db, second.id, [a]);

    expect(db.select().from(jobs).all()).toHaveLength(1);
    expect(db.select().from(runs).where(eq(runs.id, second.id)).get()).toMatchObject({ found: 1, inserted: 0 });
  });

  it('treats the same company and title from another source as duplicate', async () => {
    const { db } = setup(['a', 'b']);
    const a: Connector = { id: 'a', name: 'A', search: async () => [job(1)] };
    const b: Connector = {
      id: 'b', name: 'B',
      search: async () => [job(1, { source: 'b', url: 'https://other.com/x' })],
    };
    await executeRun(db, runFor(db, 'a').id, [a, b]);
    await executeRun(db, runFor(db, 'b').id, [a, b]);
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('applies the profile filters', async () => {
    const { db } = setup(['a']);
    const a: Connector = {
      id: 'a', name: 'A',
      search: async () => [job(1), job(2, { title: 'Python Developer', stacks: ['python'] })],
    };
    await executeRun(db, runFor(db, 'a').id, [a]);
    expect(db.select().from(jobs).all().map((j) => j.title)).toEqual(['React Developer 1']);
  });

  it('records an error without throwing, leaving other sources unaffected', async () => {
    const { db } = setup(['a', 'b']);
    const a: Connector = { id: 'a', name: 'A', search: async () => { throw new Error('boom'); } };
    const b: Connector = { id: 'b', name: 'B', search: async () => [job(1, { source: 'b' })] };
    await executeRun(db, runFor(db, 'a').id, [a, b], { retries: 0 });
    await executeRun(db, runFor(db, 'b').id, [a, b]);

    expect(runFor(db, 'a')).toMatchObject({ status: 'error', error: 'boom' });
    expect(runFor(db, 'b').status).toBe('ok');
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('retries once before failing', async () => {
    const { db } = setup(['a']);
    let calls = 0;
    const a: Connector = {
      id: 'a', name: 'A',
      search: async () => { calls++; if (calls === 1) throw new Error('flaky'); return [job(1)]; },
    };
    await executeRun(db, runFor(db, 'a').id, [a]);
    expect(calls).toBe(2);
    expect(runFor(db, 'a').status).toBe('ok');
  });

  it('fails a run whose connector exceeds the timeout', async () => {
    const { db } = setup(['a']);
    const a: Connector = { id: 'a', name: 'A', search: () => new Promise(() => {}) };
    await executeRun(db, runFor(db, 'a').id, [a], { timeoutMs: 20, retries: 0 });
    expect(runFor(db, 'a').status).toBe('error');
    expect(runFor(db, 'a').error).toContain('timeout');
  });
});
