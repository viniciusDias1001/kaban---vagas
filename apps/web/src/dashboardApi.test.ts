import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiError';
import { getDashboard } from './dashboardApi';

const reply = (status: number, body: string | null = null) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => vi.unstubAllGlobals());

describe('getDashboard', () => {
  it('asks GET /api/dashboard for the period and returns the body', async () => {
    const fetchMock = reply(200, JSON.stringify({ period: '7' }));
    await expect(getDashboard('7')).resolves.toEqual({ period: '7' });
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard?period=7');
  });
  it('throws an ApiError on a refusal and on a network failure', async () => {
    reply(500, 'boom');
    await expect(getDashboard('all')).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(getDashboard('30')).rejects.toMatchObject({ status: 0 });
  });
});
