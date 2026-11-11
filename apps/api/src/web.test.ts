import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, jobs, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { buildApp } from './app';

const profileBody = {
  name: 'React Pleno', stacks: ['react'], levels: ['pleno'], maxAgeDays: 7, regions: ['remoto'],
  sources: ['gupy', 'remotive'],
};

const INDEX =
  '<!doctype html><html><body><div id="root"></div><script src="/assets/app-abc123.js"></script></body></html>';

let db: Db;
let dist: string;

async function seedJob() {
  await db.insert(jobs).values({
    source: 'gupy', externalId: '1', url: `https://example.com/${Math.random()}`, title: 'Dev React',
    company: 'Acme', location: 'SP', country: 'BR', remote: false, stacks: ['react'], description: 'd',
    postedAt: null, discoveredAt: 1, dedupHash: String(Math.random()), profileId: null, column: 'descobertas',
    position: 0,
  });
}

beforeAll(async () => {
  db = await createTestDb();
  dist = mkdtempSync(join(tmpdir(), 'kv-web-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log("kv")');
  writeFileSync(join(dist, 'logo.png'), 'png');
});
beforeEach(() => resetTestDb(db));
afterAll(async () => {
  rmSync(dist, { recursive: true, force: true });
  await closeDb(db);
});

describe('/api prefix (sem web buildado)', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    app = buildApp(db);
  });

  it('serves the same routes under /api', async () => {
    await seedJob();
    const prefixed = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(prefixed.statusCode).toBe(200);
    expect(prefixed.json()).toEqual({ total: 1, appliedByAi: 0, appliedByHuman: 0, needsHuman: 0 });
    expect(prefixed.json()).toEqual((await app.inject({ method: 'GET', url: '/stats' })).json());

    const created = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileBody });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/api/profiles' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/profiles' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/sources' })).json()).toHaveLength(9);
    expect((await app.inject({ method: 'GET', url: '/api/runs/health' })).json().lastFinishedAt).toBeNull();
  });

  it('keeps validation and not-found errors in the JSON shape under /api', async () => {
    const invalid = await app.inject({
      method: 'POST', url: '/api/profiles', payload: { ...profileBody, maxAgeDays: 5 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('validation');
    const missing = await app.inject({ method: 'GET', url: '/api/jobs/999' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('not_found');
  });

  it('answers unknown paths with a JSON 404, with or without the prefix', async () => {
    const cases = [['GET', '/api/unknown'], ['POST', '/api/unknown'], ['GET', '/api'], ['GET', '/unknown'], ['GET', '/']] as const;
    for (const [method, url] of cases) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toEqual({ error: 'not_found', message: expect.any(String) });
    }
  });
});

describe('web buildado servido pela API', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    app = buildApp(db, { webDist: dist });
  });

  it('serves index.html at / without caching it', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toBe(INDEX);
  });

  it('serves built files, the hashed ones under /assets as immutable', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toBe('console.log("kv")');

    const logo = await app.inject({ method: 'GET', url: '/logo.png' });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['cache-control']).toBe('no-cache');
  });

  it('falls back to index.html for deep links', async () => {
    for (const url of ['/perfis', '/quadro/vaga/12?x=1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toBe(INDEX);
    }
  });

  it('still serves the API under /api and at the root', async () => {
    await seedJob();
    for (const url of ['/api/stats', '/stats']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 1 });
    }
    const created = await app.inject({ method: 'POST', url: '/api/profiles', payload: profileBody });
    expect(created.statusCode).toBe(201);
  });

  it('answers unknown /api paths with a JSON 404, never index.html', async () => {
    const cases = [['GET', '/api/unknown'], ['GET', '/api'], ['GET', '/api/'], ['GET', '/api?x=1'], ['POST', '/api/unknown']] as const;
    for (const [method, url] of cases) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toEqual({ error: 'not_found', message: expect.any(String) });
    }
  });

  it('answers 404 for a missing file and for non-GET requests outside the API', async () => {
    const cases = [['GET', '/assets/missing.js'], ['GET', '/favicon.ico'], ['POST', '/perfis']] as const;
    for (const [method, url] of cases) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error).toBe('not_found');
    }
  });

  it('does not serve files outside the dist directory', async () => {
    writeFileSync(join(dist, '..', 'kv-web-secret.txt'), 'segredo');
    try {
      for (const url of ['/../kv-web-secret.txt', '/..%2fkv-web-secret.txt', '/assets/..%2f..%2fkv-web-secret.txt']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.body, url).not.toContain('segredo');
      }
    } finally {
      rmSync(join(dist, '..', 'kv-web-secret.txt'), { force: true });
    }
  });
});
