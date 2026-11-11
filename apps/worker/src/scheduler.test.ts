import { describe, expect, it } from 'vitest';
import type { Connector } from '@kv/connectors';
import { jobs, openDb, runs, searchProfiles, type Db } from '@kv/db';
import { enqueueAllActive, failStaleRuns, isDue, msUntilNextHour, processQueue } from './scheduler';

const HOUR = 3_600_000;

function addProfile(db: Db, active: boolean, sources = ['a']) {
  return db
    .insert(searchProfiles)
    .values({ name: 'P', stacks: [], levels: [], maxAgeDays: 7, regions: [], sources, active, createdAt: 1 })
    .returning()
    .get();
}

const connector: Connector = {
  id: 'a', name: 'A',
  search: async () => [{
    source: 'a', externalId: '1', url: 'https://example.com/1', title: 'Dev', company: 'Acme', location: '',
    country: 'BR', remote: true, stacks: [], description: '', postedAt: null,
  }],
};

describe('isDue', () => {
  it('is due with no successful run, and not due right after one', () => {
    const db = openDb(':memory:');
    const now = 10 * HOUR;
    expect(isDue(db, now)).toBe(true);
    db.insert(runs)
      .values({ profileId: 1, source: 'a', trigger: 'cron', status: 'ok', createdAt: now, finishedAt: now - 60_000 })
      .run();
    expect(isDue(db, now)).toBe(false);
    expect(isDue(db, now + HOUR)).toBe(true);
  });
});

describe('enqueueAllActive', () => {
  it('queues runs only for active profiles', () => {
    const db = openDb(':memory:');
    addProfile(db, true, ['a', 'b']);
    addProfile(db, false);
    expect(enqueueAllActive(db)).toBe(2);
    expect(db.select().from(runs).all().every((r) => r.trigger === 'cron')).toBe(true);
  });
});

describe('processQueue', () => {
  it('executes every queued run', async () => {
    const db = openDb(':memory:');
    addProfile(db, true);
    enqueueAllActive(db);
    expect(await processQueue(db, [connector])).toBe(1);
    expect(db.select().from(runs).all()[0].status).toBe('ok');
    expect(db.select().from(jobs).all()).toHaveLength(1);
    expect(await processQueue(db, [connector])).toBe(0);
  });
});

describe('failStaleRuns', () => {
  it('marks runs left in running state as error', () => {
    const db = openDb(':memory:');
    db.insert(runs).values({ profileId: 1, source: 'a', trigger: 'cron', status: 'running', createdAt: 1 }).run();
    failStaleRuns(db);
    expect(db.select().from(runs).all()[0]).toMatchObject({ status: 'error', error: 'worker reiniciado' });
  });
});

describe('msUntilNextHour', () => {
  it('returns the distance to the next full hour', () => {
    expect(msUntilNextHour(new Date('2026-11-11T10:15:00.000Z').getTime())).toBe(45 * 60_000);
    expect(msUntilNextHour(new Date('2026-11-11T10:00:00.000Z').getTime())).toBe(HOUR);
  });
});
