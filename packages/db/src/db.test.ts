import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { defaultDbPath, enqueueRuns, jobs, openDb, runs, searchProfiles } from './index';

type TestDb = ReturnType<typeof openDb>;

function seedProfile(db: TestDb, sources: string[] = ['gupy', 'remotive']) {
  return db
    .insert(searchProfiles)
    .values({
      name: 'React', stacks: ['react', 'node'], levels: ['pleno'], maxAgeDays: 7,
      regions: ['remoto'], sources, active: true, createdAt: 1,
    })
    .returning()
    .get();
}

function insertRun(db: TestDb, profileId: number, source: string, status: 'queued' | 'running' | 'ok' | 'error') {
  return db.insert(runs).values({ profileId, source, trigger: 'manual', status, createdAt: Date.now() }).run();
}

function jobValues(url: string) {
  return {
    source: 'gupy', externalId: url, url, title: 'Dev', company: 'ACME', location: 'Remoto',
    country: 'BR', remote: true, level: 'pleno', stacks: ['react'], description: '',
    postedAt: null, discoveredAt: 1, dedupHash: url, profileId: 1, position: 1,
  } as typeof jobs.$inferInsert;
}

describe('defaultDbPath', () => {
  const original = process.env.DB_PATH;
  const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  afterEach(() => {
    if (original === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = original;
  });

  it('uses an absolute DB_PATH as-is', () => {
    const abs = resolve(tmpdir(), 'abs.db');
    process.env.DB_PATH = abs;
    expect(defaultDbPath()).toBe(abs);
  });

  it('passes :memory: through', () => {
    process.env.DB_PATH = ':memory:';
    expect(defaultDbPath()).toBe(':memory:');
  });

  it('resolves a relative DB_PATH against the repo root, not the cwd', () => {
    process.env.DB_PATH = './data/x.db';
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmpdir());
    try {
      const p = defaultDbPath();
      expect(isAbsolute(p)).toBe(true);
      expect(p).toBe(resolve(repoRoot, 'data/x.db'));
      expect(p).not.toBe(resolve(tmpdir(), 'data/x.db'));
    } finally {
      cwd.mockRestore();
    }
  });

  it('falls back to <repo>/data/kanban.db when DB_PATH is unset', () => {
    delete process.env.DB_PATH;
    expect(defaultDbPath()).toBe(resolve(repoRoot, 'data/kanban.db'));
  });
});

describe('openDb', () => {
  it('creates tables and round-trips JSON columns', () => {
    const db = openDb(':memory:');
    const profile = seedProfile(db);
    const read = db.select().from(searchProfiles).where(eq(searchProfiles.id, profile.id)).get();
    expect(read?.stacks).toEqual(['react', 'node']);
    expect(read?.active).toBe(true);
  });

  it('can open the same file-backed DB twice (idempotent DDL) in WAL mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-db-'));
    const file = join(dir, 'nested', 'kanban.db');
    const a = openDb(file);
    const b = openDb(file);
    try {
      seedProfile(a);
      expect(b.select().from(searchProfiles).all()).toHaveLength(1);
      expect(a.$client.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(b.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      a.$client.close();
      b.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('jobs', () => {
  it('rejects a duplicate url', () => {
    const db = openDb(':memory:');
    db.insert(jobs).values(jobValues('https://x.test/1')).run();
    expect(() => db.insert(jobs).values(jobValues('https://x.test/1')).run()).toThrow(/UNIQUE/i);
    db.insert(jobs).values(jobValues('https://x.test/2')).run();
    expect(db.select().from(jobs).all()).toHaveLength(2);
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

  it('enqueues again a source whose previous run is ok or error', () => {
    const db = openDb(':memory:');
    const profile = seedProfile(db);
    insertRun(db, profile.id, 'gupy', 'ok');
    insertRun(db, profile.id, 'remotive', 'error');
    expect(enqueueRuns(db, profile, 'manual')).toBe(2);
    const queued = db.select().from(runs).where(eq(runs.status, 'queued')).all();
    expect(queued.map((r) => r.source).sort()).toEqual(['gupy', 'remotive']);
  });

  it('does not let pending runs of profile A block profile B', () => {
    const db = openDb(':memory:');
    const a = seedProfile(db);
    const b = seedProfile(db);
    expect(enqueueRuns(db, a, 'manual')).toBe(2);
    expect(enqueueRuns(db, b, 'manual')).toBe(2);
    expect(db.select().from(runs).where(eq(runs.profileId, b.id)).all()).toHaveLength(2);
  });

  it('queues only the free source when another is pending and returns 1', () => {
    const db = openDb(':memory:');
    const profile = seedProfile(db);
    insertRun(db, profile.id, 'gupy', 'running');
    expect(enqueueRuns(db, profile, 'manual')).toBe(1);
    const queued = db.select().from(runs).where(eq(runs.status, 'queued')).all();
    expect(queued.map((r) => r.source)).toEqual(['remotive']);
  });

  it('unique index forbids two pending runs for the same (profile, source)', () => {
    const db = openDb(':memory:');
    const profile = seedProfile(db);
    insertRun(db, profile.id, 'gupy', 'queued');
    expect(() => insertRun(db, profile.id, 'gupy', 'queued')).toThrow(/UNIQUE/i);
    expect(() => insertRun(db, profile.id, 'gupy', 'running')).toThrow(/UNIQUE/i);
    // finished runs are not covered by the partial index
    insertRun(db, profile.id, 'gupy', 'ok');
    insertRun(db, profile.id, 'gupy', 'ok');
  });

  it('is idempotent against a run already pending via a second connection to the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-db-'));
    const file = join(dir, 'kanban.db');
    const a = openDb(file);
    const b = openDb(file);
    try {
      const profile = seedProfile(a);
      expect(enqueueRuns(a, profile, 'manual')).toBe(2);
      expect(enqueueRuns(b, profile, 'cron')).toBe(0);
      expect(a.select().from(runs).all()).toHaveLength(2);
    } finally {
      a.$client.close();
      b.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
