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

  it('reads the job answer (application, site, canApply) and gives null for a job that is gone (404)', async () => {
    const dto = { application: null, site: 'greenhouse', canApply: true, cannotApplyReason: null };
    const fetchMock = reply(200, JSON.stringify(dto));
    await expect(applyApi.jobApplication(3)).resolves.toEqual(dto);
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/3/application', expect.anything());
    reply(404, JSON.stringify({ error: 'not_found' }));
    await expect(applyApi.jobApplication(3)).resolves.toBeNull();
  });

  it('asks the list for one filter and returns its rows and the counts of every filter', async () => {
    const body = { items: [], counts: { active: 0, needs_human: 2, rehearsals: 0, submitted: 0, skipped: 0 } };
    const fetchMock = reply(200, JSON.stringify(body));
    await expect(applyApi.applications('needs_human')).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/applications?filter=needs_human', expect.anything());
  });

  it('posts exactly the listed rehearsal ids to send-all and returns what was queued and skipped', async () => {
    const fetchMock = reply(202, JSON.stringify({ queued: 2, skipped: 1 }));
    await expect(applyApi.sendAll([4, 5, 6])).resolves.toEqual({ queued: 2, skipped: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/applications/send-rehearsals', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ ids: [4, 5, 6] }), headers: { 'content-type': 'application/json' },
    }));
  });

  it('turns already_applied into its pt-BR message, and passes the worker reason of apply_unavailable through', async () => {
    reply(409, JSON.stringify({ error: 'already_applied', message: 'job already applied' }));
    await expect(applyApi.retry(1)).rejects.toThrow('Você já se candidatou a esta vaga');
    reply(409, JSON.stringify({ error: 'apply_unavailable', message: 'Navegador não encontrado.' }));
    await expect(applyApi.apply(1)).rejects.toThrow('Navegador não encontrado.');
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
