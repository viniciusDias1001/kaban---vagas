import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, jobEvents, jobs, runs, searchProfiles, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { buildApp } from './app';

const profileBody = {
  name: 'React Pleno', stacks: ['react'], levels: ['pleno'], maxAgeDays: 7, regions: ['remoto'],
  sources: ['gupy', 'remotive'],
};

let db: Db;
let app: ReturnType<typeof buildApp>;

async function seedJob(over: Partial<typeof jobs.$inferInsert> = {}) {
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: '1', url: `https://example.com/${Math.random()}`, title: 'Dev React',
      company: 'Acme', location: 'SP', country: 'BR', remote: false, stacks: ['react'], description: 'd',
      postedAt: null, discoveredAt: 1, dedupHash: String(Math.random()), profileId: null, column: 'descobertas',
      position: 0, ...over,
    })
    .returning();
  return row;
}

async function seedProfile() {
  const [row] = await db
    .insert(searchProfiles)
    .values({ ...profileBody, levels: ['pleno'], regions: ['remoto'], maxAgeDays: 7, createdAt: 1 })
    .returning();
  return row;
}

// Um PGlite por arquivo; cada teste começa com as tabelas vazias e os ids reiniciados.
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db);
});
afterAll(() => closeDb(db));

describe('profiles', () => {
  it('creates, lists, updates and deletes', async () => {
    const before = Date.now();
    const created = await app.inject({ method: 'POST', url: '/profiles', payload: profileBody });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ...profileBody, active: true });
    expect(created.json().createdAt).toBeGreaterThanOrEqual(before);
    const id = created.json().id;
    expect(id).toBeTypeOf('number');

    const list = (await app.inject({ method: 'GET', url: '/profiles' })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(created.json());

    const patched = await app.inject({ method: 'PATCH', url: `/profiles/${id}`, payload: { active: false } });
    expect(patched.json()).toEqual({ ...created.json(), active: false });

    const untouched = await app.inject({ method: 'PATCH', url: `/profiles/${id}`, payload: {} });
    expect(untouched.json()).toEqual(patched.json());

    expect((await app.inject({ method: 'DELETE', url: `/profiles/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/profiles' })).json()).toHaveLength(0);
  });

  it('lists newest first', async () => {
    await app.inject({ method: 'POST', url: '/profiles', payload: { ...profileBody, name: 'first' } });
    await app.inject({ method: 'POST', url: '/profiles', payload: { ...profileBody, name: 'second' } });
    const names = (await app.inject({ method: 'GET', url: '/profiles' })).json().map((p: { name: string }) => p.name);
    expect(names).toEqual(['second', 'first']);
  });

  it('rejects invalid input with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/profiles', payload: { ...profileBody, maxAgeDays: 5 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
  });

  it('returns 404 when patching an unknown or malformed id, and 204 when deleting one', async () => {
    for (const id of ['999', 'abc', '99999999999']) {
      const res = await app.inject({ method: 'PATCH', url: `/profiles/${id}`, payload: { active: false } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not_found');
      expect((await app.inject({ method: 'DELETE', url: `/profiles/${id}` })).statusCode).toBe(204);
    }
  });

  it('keeps the jobs of a deleted profile on the board', async () => {
    const profile = await seedProfile();
    const job = await seedJob({ profileId: profile.id, column: 'aplicada', notes: 'entrevista marcada' });
    await db.insert(jobEvents).values({ jobId: job.id, fromColumn: null, toColumn: 'descobertas', actor: 'sistema', createdAt: 1 });
    await db.insert(runs).values({ profileId: profile.id, source: 'gupy', trigger: 'cron', status: 'ok', createdAt: 1, finishedAt: 2 });

    expect((await app.inject({ method: 'DELETE', url: `/profiles/${profile.id}` })).statusCode).toBe(204);

    const board = (await app.inject({ method: 'GET', url: '/jobs' })).json();
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ id: job.id, profileId: null, column: 'aplicada', notes: 'entrevista marcada' });
    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
    expect(detail.events).toHaveLength(1);
    expect(await db.select().from(runs)).toHaveLength(0);
  });
});

describe('jobs', () => {
  it('lists ordered by position and filters by column and text', async () => {
    await seedJob({ title: 'B', position: 2 });
    await seedJob({ title: 'A', position: 1 });
    await seedJob({ title: 'Python Dev', position: 3, column: 'aplicada' });

    const all = (await app.inject({ method: 'GET', url: '/jobs' })).json();
    expect(all.map((j: { title: string }) => j.title)).toEqual(['A', 'B', 'Python Dev']);

    const col = (await app.inject({ method: 'GET', url: '/jobs?column=aplicada' })).json();
    expect(col).toHaveLength(1);

    const q = (await app.inject({ method: 'GET', url: '/jobs?q=python' })).json();
    expect(q).toHaveLength(1);
  });

  it('searches title and company case-insensitively', async () => {
    await seedJob({ title: 'Engenheiro de Software', company: 'NuBank' });
    await seedJob({ title: 'PYTHON Developer', company: 'Acme' });
    const titles = async (q: string) =>
      (await app.inject({ method: 'GET', url: `/jobs?q=${q}` })).json().map((j: { title: string }) => j.title);
    expect(await titles('nubank')).toEqual(['Engenheiro de Software']);
    expect(await titles('NUBANK')).toEqual(['Engenheiro de Software']);
    expect(await titles('python')).toEqual(['PYTHON Developer']);
    expect(await titles('rust')).toEqual([]);
  });

  it('filters by profile and source', async () => {
    const profile = await seedProfile();
    await seedJob({ title: 'mine', profileId: profile.id });
    await seedJob({ title: 'other', source: 'lever' });
    const titles = async (qs: string) =>
      (await app.inject({ method: 'GET', url: `/jobs?${qs}` })).json().map((j: { title: string }) => j.title);
    expect(await titles(`profile=${profile.id}`)).toEqual(['mine']);
    expect(await titles('source=lever')).toEqual(['other']);
    expect(await titles('profile=abc')).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/jobs?column=nope' })).statusCode).toBe(400);
  });

  it('serialises a job with numbers, booleans, arrays and nulls in the DTO shape', async () => {
    const now = Date.now();
    const job = await seedJob({ postedAt: now, discoveredAt: now + 1, position: -now + 0.5, stacks: ['react', 'node'] });
    const item = {
      id: job.id, source: 'gupy', externalId: '1', url: job.url, title: 'Dev React', company: 'Acme',
      location: 'SP', country: 'BR', remote: false, level: null, stacks: ['react', 'node'],
      postedAt: now, discoveredAt: now + 1, profileId: null, column: 'descobertas',
      position: -now + 0.5, appliedBy: null, needsHuman: false, needsHumanReason: null, notes: '',
      descriptionFetchedAt: null,
    };
    // A lista do quadro não traz a descrição (nem o hash interno de deduplicação)...
    const [dto] = (await app.inject({ method: 'GET', url: '/jobs' })).json();
    expect(dto).toEqual(item);
    // ...que continua vindo no detalhe da vaga.
    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
    expect(detail.job).toEqual({ ...item, description: 'd', dedupHash: job.dedupHash });
  });

  it('leaves the description out of every list variant and keeps it in PATCH responses', async () => {
    const job = await seedJob({ title: 'Python Dev', column: 'aplicada' });
    for (const qs of ['', '?q=python', '?column=aplicada', '?source=gupy']) {
      const [row] = (await app.inject({ method: 'GET', url: `/jobs${qs}` })).json();
      expect(row.id).toBe(job.id);
      expect(row).not.toHaveProperty('description');
    }
    const patched = (await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { notes: 'n' } })).json();
    expect(patched).toMatchObject({ id: job.id, notes: 'n', description: 'd' });
  });

  it('moves a job, records the event and marks human application', async () => {
    const job = await seedJob();
    const before = Date.now();
    const res = await app.inject({
      method: 'PATCH', url: `/jobs/${job.id}`, payload: { column: 'aplicada', position: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: job.id, column: 'aplicada', position: 5, appliedBy: 'humano' });

    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
    expect(detail.job).toEqual(res.json());
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({
      jobId: job.id, fromColumn: 'descobertas', toColumn: 'aplicada', actor: 'humano',
    });
    expect(detail.events[0].createdAt).toBeGreaterThanOrEqual(before);
  });

  it('does not record an event or override appliedBy when the column does not change', async () => {
    const job = await seedJob({ column: 'aplicada', appliedBy: 'ia' });
    const same = await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { column: 'aplicada' } });
    expect(same.json()).toMatchObject({ column: 'aplicada', appliedBy: 'ia' });
    await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { column: 'entrevista' } });
    const back = await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { column: 'aplicada' } });
    expect(back.json().appliedBy).toBe('ia');
    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
    expect(detail.events.map((e: { toColumn: string }) => e.toColumn)).toEqual(['entrevista', 'aplicada']);
  });

  it('saves notes without creating an event', async () => {
    const job = await seedJob();
    await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { notes: 'ligar amanhã' } });
    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
    expect(detail.job.notes).toBe('ligar amanhã');
    expect(detail.events).toHaveLength(0);
  });

  it('returns the job unchanged for an empty patch', async () => {
    const job = await seedJob();
    const res = await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: job.id, column: 'descobertas', position: 0 });
  });

  it('returns 404 for an unknown job', async () => {
    expect((await app.inject({ method: 'GET', url: '/jobs/999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/jobs/999', payload: {} })).statusCode).toBe(404);
  });

  it('returns 404, not 500, for ids Postgres cannot take as integer', async () => {
    for (const id of ['abc', '1.5', '99999999999']) {
      expect((await app.inject({ method: 'GET', url: `/jobs/${id}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'PATCH', url: `/jobs/${id}`, payload: {} })).statusCode).toBe(404);
    }
  });
});

describe('runs', () => {
  it('queues one run per source of the profile', async () => {
    const id = (await app.inject({ method: 'POST', url: '/profiles', payload: profileBody })).json().id;
    const res = await app.inject({ method: 'POST', url: '/runs', payload: { profileId: id } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: 2 });
    expect(await db.select().from(runs)).toHaveLength(2);

    const again = await app.inject({ method: 'POST', url: '/runs', payload: { profileId: id } });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ queued: 0 });
  });

  it('returns 404 when the profile does not exist', async () => {
    expect((await app.inject({ method: 'POST', url: '/runs', payload: { profileId: 42 } })).statusCode).toBe(404);
    const huge = await app.inject({ method: 'POST', url: '/runs', payload: { profileId: 99999999999 } });
    expect(huge.statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/runs', payload: {} })).statusCode).toBe(400);
  });

  it('reports the latest finished run per source', async () => {
    const profile = await seedProfile();
    await db.insert(runs).values([
      { profileId: profile.id, source: 'gupy', trigger: 'cron', status: 'ok', found: 3, inserted: 1, createdAt: 1, finishedAt: 10 },
      { profileId: profile.id, source: 'gupy', trigger: 'cron', status: 'error', error: 'HTTP 500', createdAt: 2, finishedAt: 20 },
    ]);
    const health = (await app.inject({ method: 'GET', url: '/runs/health' })).json();
    const gupy = health.sources.find((s: { source: string }) => s.source === 'gupy');
    expect(gupy).toMatchObject({ status: 'error', error: 'HTTP 500', finishedAt: 20 });
    expect(health.sources.find((s: { source: string }) => s.source === 'lever').status).toBe('never');
    expect(health.lastFinishedAt).toBe(20);
  });

  it('reports never and null when nothing has run', async () => {
    const health = (await app.inject({ method: 'GET', url: '/runs/health' })).json();
    expect(health.lastFinishedAt).toBeNull();
    expect(health.sources.every((s: { status: string; finishedAt: unknown }) => s.status === 'never' && s.finishedAt === null)).toBe(true);
  });
});

describe('meta', () => {
  it('lists sources', async () => {
    const sources = (await app.inject({ method: 'GET', url: '/sources' })).json();
    expect(sources).toHaveLength(9);
    expect(sources[0]).toEqual({ id: 'gupy', name: 'Gupy' });
  });

  it('counts jobs for the stats bar, as numbers', async () => {
    await seedJob({ appliedBy: 'ia', column: 'aplicada' });
    await seedJob({ appliedBy: 'humano', column: 'aplicada' });
    await seedJob({ needsHuman: true });
    const res = await app.inject({ method: 'GET', url: '/stats' });
    expect(res.json()).toEqual({ total: 3, appliedByAi: 1, appliedByHuman: 1, needsHuman: 1 });
    expect(res.body).toBe('{"total":3,"appliedByAi":1,"appliedByHuman":1,"needsHuman":1}');
  });

  it('returns zeros for an empty board', async () => {
    const stats = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(stats).toEqual({ total: 0, appliedByAi: 0, appliedByHuman: 0, needsHuman: 0 });
  });
});
