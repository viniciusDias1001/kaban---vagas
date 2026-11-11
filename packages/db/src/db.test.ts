import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { enqueueRuns, openDb, runs, searchProfiles } from './index';

function seedProfile(db: ReturnType<typeof openDb>) {
  return db
    .insert(searchProfiles)
    .values({
      name: 'React', stacks: ['react', 'node'], levels: ['pleno'], maxAgeDays: 7,
      regions: ['remoto'], sources: ['gupy', 'remotive'], active: true, createdAt: 1,
    })
    .returning()
    .get();
}

describe('openDb', () => {
  it('creates tables and round-trips JSON columns', () => {
    const db = openDb(':memory:');
    const profile = seedProfile(db);
    const read = db.select().from(searchProfiles).where(eq(searchProfiles.id, profile.id)).get();
    expect(read?.stacks).toEqual(['react', 'node']);
    expect(read?.active).toBe(true);
  });
});

describe('enqueueRuns', () => {
  it('queues one run per source and skips sources already pending', () => {
    const db = openDb(':memory:');
    const profile = seedProfile(db);
    expect(enqueueRuns(db, profile, 'manual')).toBe(2);
    expect(enqueueRuns(db, profile, 'cron')).toBe(0);
    const rows = db.select().from(runs).all();
    expect(rows.map((r) => r.source).sort()).toEqual(['gupy', 'remotive']);
    expect(rows.every((r) => r.status === 'queued' && r.trigger === 'manual')).toBe(true);
  });
});
