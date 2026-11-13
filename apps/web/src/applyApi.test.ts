import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiError';
import { applyApi } from './applyApi';

const reply = (status: number, body: string | null = null) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => vi.unstubAllGlobals());

describe('applyApi', () => {
  it('treats a 2xx with an empty body as a success with no value, whatever the status', async () => {
    reply(202);
    await expect(applyApi.retry(1)).resolves.toBeUndefined();
    reply(202, '');
    await expect(applyApi.send(1)).resolves.toBeUndefined();
    reply(204);
    await expect(applyApi.cancel(1)).resolves.toBeUndefined();
  });

  it('returns the body of a 202 that has one', async () => {
    const fetchMock = reply(202, JSON.stringify({ id: 7 }));
    await expect(applyApi.apply(3)).resolves.toEqual({ id: 7 });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/3/application', expect.objectContaining({ method: 'POST' }));
  });

  it('gives null for a job without an application (200 null) and for a job that is gone (404)', async () => {
    reply(200, 'null');
    await expect(applyApi.jobApplication(3)).resolves.toBeNull();
    reply(404, JSON.stringify({ error: 'not_found' }));
    await expect(applyApi.jobApplication(3)).resolves.toBeNull();
  });

  it('rejects with the pt-BR message of a known 409 code', async () => {
    reply(409, JSON.stringify({ error: 'sent' }));
    const error = await applyApi.retry(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe('Esta candidatura já foi enviada.');
  });

  it('rejects a 500 with the general text', async () => {
    reply(500, '<html>boom</html>');
    await expect(applyApi.status()).rejects.toThrow('erro 500');
  });

  it('rejects a 200 whose body is not JSON', async () => {
    reply(200, 'not json');
    await expect(applyApi.status()).rejects.toThrow('respondeu algo inesperado');
  });
});
