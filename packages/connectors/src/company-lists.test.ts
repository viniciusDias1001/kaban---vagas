import { afterEach, describe, expect, it, vi } from 'vitest';
import { greenhouse } from './greenhouse';
import { lever } from './lever';

const filters = { stacks: [], levels: [], maxAgeDays: 7 as const, regions: [] };

/** Troca o `fetch` global por um que guarda as URLs e responde uma lista vazia no formato de cada fonte. */
function captureUrls(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return new Response(url.includes('greenhouse') ? '{"jobs":[]}' : '[]', { status: 200 });
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('company lists of Greenhouse and Lever', () => {
  it('use the list handed in by the worker, ahead of the environment', async () => {
    vi.stubEnv('GREENHOUSE_BOARDS', 'do-ambiente');
    vi.stubEnv('LEVER_COMPANIES', 'do-ambiente');
    const urls = captureUrls();
    await greenhouse.search(filters, undefined, { greenhouseBoards: ['acme', 'beta'] });
    await lever.search(filters, undefined, { leverCompanies: ['gama'] });
    expect(urls).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true',
      'https://boards-api.greenhouse.io/v1/boards/beta/jobs?content=true',
      'https://api.lever.co/v0/postings/gama?mode=json',
    ]);
  });

  it('fall back to the environment variable, then to the code default, when nothing is handed in', async () => {
    vi.stubEnv('GREENHOUSE_BOARDS', 'do-ambiente');
    vi.stubEnv('LEVER_COMPANIES', '');
    const urls = captureUrls();
    await greenhouse.search(filters);
    await lever.search(filters, undefined, { leverCompanies: [] });
    expect(urls.map((u) => u.split('/').at(u.includes('greenhouse') ? 5 : 5)?.split('?')[0])).toEqual(['do-ambiente', 'palantir', 'spotify']);
  });

  it('each connector ignores the list of the other', async () => {
    vi.stubEnv('GREENHOUSE_BOARDS', '');
    const urls = captureUrls();
    await greenhouse.search(filters, undefined, { leverCompanies: ['gama'] });
    expect(urls).toHaveLength(4);
    expect(urls.every((u) => u.includes('greenhouse') && !u.includes('gama'))).toBe(true);
  });
});
