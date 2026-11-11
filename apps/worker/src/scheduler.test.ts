import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connector } from '@kv/connectors';
import { closeDb, jobs, runs, searchProfiles, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { enqueueAllActive, failStaleRuns, isDue, msUntilNextHour, processQueue } from './scheduler';

const HOUR = 3_600_000;

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function addProfile(active: boolean, sources = ['a']) {
  const [row] = await db
    .insert(searchProfiles)
    .values({ name: 'P', stacks: [], levels: [], maxAgeDays: 7, regions: [], sources, active, createdAt: 1 })
    .returning();
  return row;
}

const connector: Connector = {
  id: 'a', name: 'A',
  search: async () => [{
    source: 'a', externalId: '1', url: 'https://example.com/1', title: 'Dev', company: 'Acme', location: '',
    country: 'BR', remote: true, stacks: [], description: '', postedAt: null,
  }],
};

describe('isDue', () => {
  it('is due with no successful run, and not due right after one', async () => {
    const profile = await addProfile(true);
    const now = 10 * HOUR;
    expect(await isDue(db, now)).toBe(true);
    await db.insert(runs).values({
      profileId: profile.id, source: 'a', trigger: 'cron', status: 'ok', createdAt: now, finishedAt: now - 60_000,
    });
    expect(await isDue(db, now)).toBe(false);
    expect(await isDue(db, now + HOUR)).toBe(true);
  });

  it('ignores failed and unfinished runs', async () => {
    const profile = await addProfile(true, ['a', 'b']);
    const now = Date.now();
    await db.insert(runs).values([
      { profileId: profile.id, source: 'a', trigger: 'cron', status: 'error', createdAt: now, finishedAt: now },
      { profileId: profile.id, source: 'b', trigger: 'cron', status: 'running', createdAt: now },
    ]);
    expect(await isDue(db)).toBe(true);
  });
});

describe('enqueueAllActive', () => {
  it('queues runs only for active profiles', async () => {
    await addProfile(true, ['a', 'b']);
    await addProfile(false);
    expect(await enqueueAllActive(db)).toBe(2);
    expect((await db.select().from(runs)).every((r) => r.trigger === 'cron')).toBe(true);
  });
});

describe('processQueue', () => {
  it('executes every queued run', async () => {
    await addProfile(true);
    await enqueueAllActive(db);
    expect(await processQueue(db, [connector])).toBe(1);
    expect((await db.select().from(runs))[0].status).toBe('ok');
    expect(await db.select().from(jobs)).toHaveLength(1);
    expect(await processQueue(db, [connector])).toBe(0);
  });

  it('runs several sources in parallel without duplicating a job they share', async () => {
    await addProfile(true, ['a', 'b']);
    await enqueueAllActive(db);
    const other: Connector = { id: 'b', name: 'B', search: connector.search };
    expect(await processQueue(db, [connector, other])).toBe(2);
    expect((await db.select().from(runs)).map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });
});

describe('failStaleRuns', () => {
  it('marks runs left in running state as error', async () => {
    const profile = await addProfile(true);
    await db.insert(runs).values({ profileId: profile.id, source: 'a', trigger: 'cron', status: 'running', createdAt: 1 });
    await failStaleRuns(db);
    const [run] = await db.select().from(runs);
    expect(run).toMatchObject({ status: 'error', error: 'worker reiniciado' });
    expect(run.finishedAt).toBeTypeOf('number');
  });
});

describe('msUntilNextHour', () => {
  it('returns the distance to the next full hour', () => {
    expect(msUntilNextHour(new Date('2026-11-11T10:15:00.000Z').getTime())).toBe(45 * 60_000);
    expect(msUntilNextHour(new Date('2026-11-11T10:00:00.000Z').getTime())).toBe(HOUR);
  });
});
