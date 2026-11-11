import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { closeDb, jobs, searchProfiles, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { buildApp, isSameOrigin } from './app';

const NUL = String.fromCharCode(0);

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

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => closeDb(db));

describe('CORS', () => {
  it('sends no CORS headers to a cross-origin request', async () => {
    const res = await app.inject({ method: 'GET', url: '/stats', headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not answer a CORS preflight', async () => {
    const res = await app.inject({
      method: 'OPTIONS', url: '/profiles',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });
});

describe('cross-origin guard on state-changing methods', () => {
  const post = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/profiles', payload: profileBody, headers });

  it('rejects a POST whose Origin is another site, without touching the database', async () => {
    const res = await post({ origin: 'https://evil.example', host: 'localhost:3333' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', message: expect.any(String) });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(await db.select().from(searchProfiles)).toHaveLength(0);
  });

  it('rejects a DNS-rebinding style request: Origin of the attacker, Host of the local API', async () => {
    const res = await post({ origin: 'http://evil.example:3333', host: '127.0.0.1:3333' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects PATCH, PUT and DELETE from another origin too, under / and under /api', async () => {
    const job = await seedJob();
    const headers = { origin: 'https://evil.example', host: 'localhost:3333' };
    for (const [method, url] of [
      ['PATCH', `/jobs/${job.id}`], ['PATCH', `/api/jobs/${job.id}`], ['DELETE', '/profiles/1'], ['PUT', '/profiles/1'],
      ['POST', '/api/runs'],
    ] as const) {
      const res = await app.inject({ method, url, payload: { notes: 'x' }, headers });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await db.select().from(jobs))[0].notes).toBe('');
  });

  it('rejects an opaque Origin ("null": sandboxed iframe, file://)', async () => {
    expect((await post({ origin: 'null', host: 'localhost:3333' })).statusCode).toBe(403);
  });

  it('accepts a same-origin POST: the web served by the API, or the Vite dev proxy (which keeps Host)', async () => {
    for (const [origin, host] of [
      ['http://localhost:3333', 'localhost:3333'],
      ['http://localhost:5173', 'localhost:5173'],
      ['http://127.0.0.1:5173', '127.0.0.1:5173'],
      ['https://kanban.example.com', 'kanban.example.com'],
      ['https://Kanban.Example.com', 'kanban.example.com'],
    ]) {
      expect((await post({ origin, host })).statusCode, origin).toBe(201);
    }
  });

  it('accepts requests without Origin (curl, scripts) and never blocks reads', async () => {
    expect((await app.inject({ method: 'POST', url: '/profiles', payload: profileBody })).statusCode).toBe(201);
    const read = await app.inject({
      method: 'GET', url: '/profiles', headers: { origin: 'https://evil.example', host: 'localhost:3333' },
    });
    expect(read.statusCode).toBe(200);
  });

  it('compares host and port', () => {
    expect(isSameOrigin('http://localhost:5173', 'localhost:5173')).toBe(true);
    expect(isSameOrigin('http://localhost:5173', 'localhost:3333')).toBe(false);
    expect(isSameOrigin('http://localhost:5173', '127.0.0.1:5173')).toBe(false);
    expect(isSameOrigin('http://localhost:5173', undefined)).toBe(false);
    expect(isSameOrigin('not an origin', 'localhost:5173')).toBe(false);
  });
});

describe('error handler', () => {
  /** Um banco cujo SELECT falha como o Drizzle falha: mensagem com SQL e parâmetros, causa = erro do driver. */
  function brokenDb(): Db {
    return new Proxy(db, {
      get(target, key, receiver) {
        if (key !== 'select') return Reflect.get(target, key, receiver);
        return () => {
          throw new Error('Failed query: select "id" from "search_profiles" where "name" = $1\nparams: hunter2', {
            cause: new Error('connection terminated unexpectedly'),
          });
        };
      },
    });
  }

  it('answers a 500 with a generic body and logs the cause with method and URL', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await buildApp(brokenDb()).inject({ method: 'GET', url: '/api/profiles?x=1' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: 'erro interno' });
    expect(res.body).not.toMatch(/Failed query|search_profiles|hunter2/);

    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0][0]);
    expect(line).toContain('GET /api/profiles?x=1');
    expect(line).toContain('connection terminated unexpectedly');
    expect(line).not.toContain('hunter2'); // os parâmetros da query não vão para o log
  });

  it('answers malformed JSON with 400 bad_request, without logging', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.inject({
      method: 'POST', url: '/profiles', payload: '{"name": ', headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: expect.any(String) });
    expect(logged).not.toHaveBeenCalled();
  });

  it('answers an oversized body with 413 bad_request', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/jobs/1', payload: JSON.stringify({ notes: 'x'.repeat(2 * 1024 * 1024) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('bad_request');
  });

  it('keeps the validation and not_found shapes', async () => {
    const invalid = await app.inject({ method: 'POST', url: '/profiles', payload: { ...profileBody, maxAgeDays: 5 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'validation', message: expect.stringContaining('maxAgeDays') });
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('not_found');
  });
});

describe('validation', () => {
  const create = (over: object) => app.inject({ method: 'POST', url: '/profiles', payload: { ...profileBody, ...over } });

  it('rejects unknown sources with a 400 that names them, on create and on patch', async () => {
    const res = await create({ sources: ['gupy', 'glassdoor', 'monster'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
    expect(res.json().message).toContain('fontes desconhecidas: "glassdoor", "monster"');
    expect(res.json().message).toContain('Fontes disponíveis: gupy, remotive');
    expect(await db.select().from(searchProfiles)).toHaveLength(0);

    const id = (await create({})).json().id;
    const patched = await app.inject({ method: 'PATCH', url: `/profiles/${id}`, payload: { sources: ['nope'] } });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().message).toContain('fonte desconhecida: "nope"');
    expect((await db.select().from(searchProfiles))[0].sources).toEqual(['gupy', 'remotive']);
    // Um PATCH que não mexe em `sources` continua valendo.
    expect((await app.inject({ method: 'PATCH', url: `/profiles/${id}`, payload: { active: false } })).statusCode).toBe(200);
  });

  it('accepts the fake source only with FAKE_CONNECTORS=1', async () => {
    expect((await create({ sources: ['fake'] })).statusCode).toBe(400);
    vi.stubEnv('FAKE_CONNECTORS', '1');
    expect((await create({ sources: ['fake'] })).statusCode).toBe(201);
    expect((await create({ sources: ['gupy'] })).statusCode).toBe(400);
  });

  it('rejects NUL characters with 400 instead of failing in the database', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = await seedJob();
    const responses = [
      await create({ name: `a${NUL}b` }),
      await create({ stacks: [`re${NUL}act`] }),
      await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { notes: `oi${NUL}` } }),
      await app.inject({ method: 'GET', url: '/jobs?q=a%00b' }),
      await app.inject({ method: 'GET', url: '/jobs?source=gu%00py' }),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation');
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it('caps the profile name, the stacks, the notes and the search text', async () => {
    const job = await seedJob();
    const notes = (n: number) => app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { notes: 'n'.repeat(n) } });
    expect((await create({ name: 'n'.repeat(80) })).statusCode).toBe(201);
    expect((await create({ name: 'n'.repeat(81) })).statusCode).toBe(400);
    expect((await create({ stacks: ['s'.repeat(41)] })).statusCode).toBe(400);
    expect((await create({ stacks: Array.from({ length: 21 }, (_, i) => `s${i}`) })).statusCode).toBe(400);
    expect((await notes(20_000)).statusCode).toBe(200);
    expect((await notes(20_001)).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/jobs?q=${'q'.repeat(100)}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/jobs?q=${'q'.repeat(101)}` })).statusCode).toBe(400);
  });
});

describe('GET /jobs query string', () => {
  const titles = async (qs: string) =>
    (await app.inject({ method: 'GET', url: `/jobs?${qs}` })).json().map((j: { title: string }) => j.title);

  it('rejects repeated parameters with 400', async () => {
    for (const qs of ['q=a&q=b', 'column=aplicada&column=oferta', 'source=gupy&source=lever', 'profile=1&profile=2']) {
      const res = await app.inject({ method: 'GET', url: `/jobs?${qs}` });
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error).toBe('validation');
    }
  });

  it('treats empty parameters as absent and ignores unknown ones', async () => {
    await seedJob({ title: 'A' });
    expect(await titles('q=&column=&source=&profile=&other=1')).toEqual(['A']);
  });

  it('matches %, _ and backslash literally', async () => {
    await seedJob({ title: '100% remoto', position: 1 });
    await seedJob({ title: 'dev_ops', position: 2 });
    await seedJob({ title: 'C:\\temp', position: 3 });
    await seedJob({ title: 'Engenheira de dados', position: 4 });
    expect(await titles('q=%25')).toEqual(['100% remoto']);
    expect(await titles('q=_')).toEqual(['dev_ops']);
    expect(await titles(`q=${encodeURIComponent('\\')}`)).toEqual(['C:\\temp']);
    expect(await titles('q=0%25%20r')).toEqual(['100% remoto']);
    expect(await titles('q=dev%25ops')).toEqual([]);
  });
});

describe('PATCH /jobs/:id position', () => {
  const board = async (column = 'descobertas') =>
    (await db.select().from(jobs).where(eq(jobs.column, column as 'descobertas')).orderBy(asc(jobs.position), asc(jobs.id)))
      .map((j) => [j.title, j.position]);
  const move = (id: number, payload: object) => app.inject({ method: 'PATCH', url: `/jobs/${id}`, payload });

  it('stores the requested position as is when it collides with nobody', async () => {
    const a = await seedJob({ title: 'A', position: 0 });
    await seedJob({ title: 'B', position: 1 });
    const res = await move(a.id, { position: 1.5 });
    expect(res.json().position).toBe(1.5);
    expect(await board()).toEqual([['B', 1], ['A', 1.5]]);
  });

  it('renumbers the column when the requested position equals a neighbour, keeping the intended slot', async () => {
    // B e C são doubles vizinhos: o ponto médio entre eles "cai" em cima de B.
    const b = 1;
    const c = 1 + Number.EPSILON;
    expect((b + c) / 2).toBe(b);
    await seedJob({ title: 'A', position: -7.25 });
    await seedJob({ title: 'B', position: b });
    await seedJob({ title: 'C', position: c });
    const moved = await seedJob({ title: 'M', position: 40 });
    await seedJob({ title: 'other column', position: b, column: 'aplicada' });

    const res = await move(moved.id, { position: (b + c) / 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: moved.id, position: 2 });
    expect(await board()).toEqual([['A', 0], ['B', 1], ['M', 2], ['C', 3]]);
    expect(await board('aplicada')).toEqual([['other column', 1]]); // as outras colunas não mudam
  });

  it('renumbers the target column when the card comes from another column', async () => {
    await seedJob({ title: 'X', position: 5, column: 'aplicada' });
    await seedJob({ title: 'Y', position: 5, column: 'aplicada' });
    const moved = await seedJob({ title: 'M', position: 0 });
    const res = await move(moved.id, { column: 'aplicada', position: 5 });
    expect(res.json()).toMatchObject({ column: 'aplicada', position: 1, appliedBy: 'humano' });
    expect(await board('aplicada')).toEqual([['X', 0], ['M', 1], ['Y', 2]]);
    expect(await board()).toEqual([]);
  });

  it('normalises a legacy column of huge negative positions the first time a drop collides', async () => {
    const top = -1_800_000_000_000;
    for (let i = 0; i < 4; i++) await seedJob({ title: `L${i}`, position: top + i });

    // Solta sempre o terceiro card entre o primeiro e o segundo, como o quadro faz (ponto médio): o
    // intervalo entre os dois cai pela metade a cada vez, até não sobrar double entre eles.
    let collided = false;
    let drops = 0;
    for (; drops < 80 && !collided; drops++) {
      const order = await db.select().from(jobs).orderBy(asc(jobs.position), asc(jobs.id));
      const [first, second, third, fourth] = order;
      const requested = (first.position + second.position) / 2;
      collided = requested === first.position || requested === second.position;
      expect((await move(third.id, { position: requested })).statusCode).toBe(200);
      const titlesNow = (await board()).map(([title]) => title);
      expect(titlesNow, `drop ${drops}`).toEqual([first.title, third.title, second.title, fourth.title]);
    }
    expect(collided).toBe(true);
    expect(drops).toBeLessThan(20); // com posições ~1,8e12 a precisão acaba em poucos movimentos
    expect((await board()).map(([, position]) => position)).toEqual([0, 1, 2, 3]);
  });

  it('keeps working without a position (notes or column only)', async () => {
    const a = await seedJob({ title: 'A', position: 3 });
    await seedJob({ title: 'B', position: 3 });
    expect((await move(a.id, { notes: 'oi' })).json()).toMatchObject({ position: 3, notes: 'oi' });
    expect((await move(a.id, { column: 'oferta' })).json()).toMatchObject({ position: 3, column: 'oferta' });
  });
});
