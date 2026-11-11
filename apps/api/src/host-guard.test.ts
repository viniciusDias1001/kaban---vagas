import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import { closeDb, resumes, saveProfile, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { testAi } from './ai-testing';
import { buildApp, isAllowedHost } from './app';
import { resolveAllowedHosts } from './config';

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi(), allowedHosts: [] });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => closeDb(db));

const get = (url: string, host: string | undefined, target = app) =>
  target.inject({ method: 'GET', url, headers: host === undefined ? {} : { host } });

describe('Host guard (DNS rebinding)', () => {
  it('rejects, on both mounts and for every method, a request whose Host is not this app', async () => {
    await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
    for (const url of ['/ai/profile', '/api/ai/profile', '/jobs', '/api/stats', '/settings']) {
      const res = await get(url, 'evil.example:3333');
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toEqual({ error: 'forbidden', message: 'host não permitido' });
      expect(res.body).not.toContain('Maria');
    }
    // Uma página maliciosa que religou o próprio nome para 127.0.0.1 manda Origin e Host iguais: passava pela trava de origem.
    const post = await app.inject({
      method: 'POST', url: '/api/settings/ai/test', headers: { host: 'evil.example:3333', origin: 'http://evil.example:3333' },
    });
    expect(post.statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/settings/ai-keys/openai', headers: { host: 'evil.example' } });
    expect(del.statusCode).toBe(403);
  });

  it('accepts localhost, loopback and any IP literal, with or without a port', async () => {
    for (const host of [
      'localhost', 'localhost:5173', 'LOCALHOST:3333', 'localhost.:3333', '127.0.0.1:3333', '[::1]:3333', '[::1]', 'host.docker.internal:8080',
      // IP não pode ser religado por DNS: o container acessado pelo IP da rede continua funcionando.
      '192.168.0.10:8080', '172.17.0.2:8080', '[fd00::1]:8080',
    ]) {
      expect((await get('/api/stats', host)).statusCode, host).toBe(200);
    }
  });

  it('accepts the hostnames listed in ALLOWED_HOSTS and nothing that only looks like them', async () => {
    const railway = buildApp(db, { ai: testAi(), allowedHosts: ['kanban.example.com', 'healthcheck.railway.app'] });
    expect((await get('/api/stats', 'kanban.example.com', railway)).statusCode).toBe(200);
    expect((await get('/api/stats', 'Kanban.Example.com:443', railway)).statusCode).toBe(200);
    expect((await get('/api/stats', 'healthcheck.railway.app', railway)).statusCode).toBe(200);
    for (const host of ['evil-kanban.example.com', 'kanban.example.com.evil.example', 'localhost.evil.example', '127.0.0.1.evil.example']) {
      expect((await get('/api/stats', host, railway)).statusCode, host).toBe(403);
    }
    await railway.close();
  });

  it('rejects a Host that is not a host at all', () => {
    for (const host of [undefined, '', 'localhost/evil.example', 'evil.example@localhost', 'localhost:3333:1', 'localhost evil', '999.1.1.1.example']) {
      expect(isAllowedHost(host, []), String(host)).toBe(false);
    }
    expect(isAllowedHost('localhost:3333', [])).toBe(true);
  });

  it('reads ALLOWED_HOSTS (comma separated) and the Railway domains from the environment', () => {
    expect(resolveAllowedHosts({})).toEqual([]);
    expect(resolveAllowedHosts({ ALLOWED_HOSTS: ' Kanban.Example.com , outro.example:8080,, https://com-esquema.example/x ' })).toEqual([
      'kanban.example.com', 'outro.example', 'com-esquema.example',
    ]);
    // No Railway: o domínio público e o privado do serviço e o host de onde vem o healthcheck entram sozinhos.
    expect(resolveAllowedHosts({ RAILWAY_PUBLIC_DOMAIN: 'kanban-production.up.railway.app', RAILWAY_PRIVATE_DOMAIN: 'kanban.railway.internal' })).toEqual([
      'kanban-production.up.railway.app', 'kanban.railway.internal', 'healthcheck.railway.app',
    ]);
  });
});

describe('multipart parsing failures', () => {
  const boundary = 'kvTruncated';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cv.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n%resto do arquivo que nunca chega`);

  it('a truncated upload (no closing boundary) is a 400 with a fixed message, not a 500 with a stack in the log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.inject({
      method: 'POST', url: '/api/ai/resumes/pt-BR', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: head,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: 'O envio do arquivo chegou incompleto ou em formato inválido. Envie o arquivo de novo.' });
    expect(logged).not.toHaveBeenCalled();
    expect(await db.select({ id: resumes.id }).from(resumes)).toEqual([]);
  });

  it('a multipart request without a boundary is a 4xx too', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.inject({ method: 'POST', url: '/ai/resumes/pt-BR', headers: { 'content-type': 'multipart/form-data' }, payload: head });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(logged).not.toHaveBeenCalled();
  });
});
