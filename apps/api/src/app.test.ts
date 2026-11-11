import { beforeEach, describe, expect, it } from 'vitest';
import { jobs, openDb, runs, type Db } from '@kv/db';
import { buildApp } from './app';

const profileBody = {
  name: 'React Pleno', stacks: ['react'], levels: ['pleno'], maxAgeDays: 7, regions: ['remoto'],
  sources: ['gupy', 'remotive'],
};

let db: Db;
let app: ReturnType<typeof buildApp>;

function seedJob(over: Partial<typeof jobs.$inferInsert> = {}) {
  return db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: '1', url: `https://example.com/${Math.random()}`, title: 'Dev React',
      company: 'Acme', location: 'SP', country: 'BR', remote: false, stacks: ['react'], description: 'd',
      postedAt: null, discoveredAt: 1, dedupHash: String(Math.random()), profileId: 1, column: 'descobertas',
      position: 0, ...over,
    })
    .returning()
    .get();
}

beforeEach(() => {
  db = openDb(':memory:');
  app = buildApp(db);
});

describe('profiles', () => {
  it('creates, lists, updates and deletes', async () => {
    const created = await app.inject({ method: 'POST', url: '/profiles', payload: profileBody });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    expect((await app.inject({ method: 'GET', url: '/profiles' })).json()).toHaveLength(1);

    const patched = await app.inject({ method: 'PATCH', url: `/profiles/${id}`, payload: { active: false } });
    expect(patched.json().active).toBe(false);

    expect((await app.inject({ method: 'DELETE', url: `/profiles/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/profiles' })).json()).toHaveLength(0);
  });

  it('rejects invalid input with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/profiles', payload: { ...profileBody, maxAgeDays: 5 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
  });
});

describe('jobs', () => {
  it('lists ordered by position and filters by column and text', async () => {
    seedJob({ title: 'B', position: 2 });
    seedJob({ title: 'A', position: 1 });
    seedJob({ title: 'Python Dev', position: 3, column: 'aplicada' });

    const all = (await app.inject({ method: 'GET', url: '/jobs' })).json();
    expect(all.map((j: { title: string }) => j.title)).toEqual(['A', 'B', 'Python Dev']);

    const col = (await app.inject({ method: 'GET', url: '/jobs?column=aplicada' })).json();
    expect(col).toHaveLength(1);

    const q = (await app.inject({ method: 'GET', url: '/jobs?q=python' })).json();
    expect(q).toHaveLength(1);
  });

  it('moves a job, records the event and marks human application', async () => {
    const job = seedJob();
    const res = await app.inject({
      method: 'PATCH', url: `/jobs/${job.id}`, payload: { column: 'aplicada', position: 5 },
    });
    expect(res.json()).toMatchObject({ column: 'aplicada', position: 5, appliedBy: 'humano' });

    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({ fromColumn: 'descobertas', toColumn: 'aplicada', actor: 'humano' });
  });

  it('saves notes without creating an event', async () => {
    const job = seedJob();
    await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { notes: 'ligar amanhã' } });
    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
    expect(detail.job.notes).toBe('ligar amanhã');
    expect(detail.events).toHaveLength(0);
  });

  it('returns 404 for an unknown job', async () => {
    expect((await app.inject({ method: 'GET', url: '/jobs/999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/jobs/999', payload: {} })).statusCode).toBe(404);
  });
});

describe('runs', () => {
  it('queues one run per source of the profile', async () => {
    const id = (await app.inject({ method: 'POST', url: '/profiles', payload: profileBody })).json().id;
    const res = await app.inject({ method: 'POST', url: '/runs', payload: { profileId: id } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: 2 });
    expect(db.select().from(runs).all()).toHaveLength(2);
  });

  it('returns 404 when the profile does not exist', async () => {
    expect((await app.inject({ method: 'POST', url: '/runs', payload: { profileId: 42 } })).statusCode).toBe(404);
  });

  it('reports the latest finished run per source', async () => {
    db.insert(runs).values([
      { profileId: 1, source: 'gupy', trigger: 'cron', status: 'ok', found: 3, inserted: 1, createdAt: 1, finishedAt: 10 },
      { profileId: 1, source: 'gupy', trigger: 'cron', status: 'error', error: 'HTTP 500', createdAt: 2, finishedAt: 20 },
    ]).run();
    const health = (await app.inject({ method: 'GET', url: '/runs/health' })).json();
    const gupy = health.sources.find((s: { source: string }) => s.source === 'gupy');
    expect(gupy).toMatchObject({ status: 'error', error: 'HTTP 500', finishedAt: 20 });
    expect(health.sources.find((s: { source: string }) => s.source === 'lever').status).toBe('never');
    expect(health.lastFinishedAt).toBe(20);
  });
});

describe('meta', () => {
  it('lists sources', async () => {
    const sources = (await app.inject({ method: 'GET', url: '/sources' })).json();
    expect(sources).toHaveLength(9);
    expect(sources[0]).toEqual({ id: 'gupy', name: 'Gupy' });
  });

  it('counts jobs for the stats bar', async () => {
    seedJob({ appliedBy: 'ia', column: 'aplicada' });
    seedJob({ appliedBy: 'humano', column: 'aplicada' });
    seedJob({ needsHuman: true });
    const stats = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(stats).toEqual({ total: 3, appliedByAi: 1, appliedByHuman: 1, needsHuman: 1 });
  });
});
