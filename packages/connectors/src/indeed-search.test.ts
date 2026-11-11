import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchFilters } from '@kv/shared';
import { createIndeed, openIndeedSession, type IndeedSession } from './indeed';

const html = readFileSync(new URL('../fixtures/indeed.html', import.meta.url), 'utf8');
const filters = (over: Partial<SearchFilters> = {}): SearchFilters => ({
  stacks: ['react', 'node'], levels: [], maxAgeDays: 7, regions: ['brasil', 'exterior'], ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Navegador de mentira com relógio próprio: cada navegação e cada pausa avançam o tempo. */
function fakeBrowser(opts: { navMs?: number; fail?: (url: string, n: number) => boolean } = {}) {
  const state = {
    now: 1_000_000,
    opened: 0,
    closed: 0,
    open: 0,
    maxOpen: 0,
    urls: [] as string[],
    timeouts: [] as number[],
    log: [] as string[],
  };
  const deps = {
    now: () => state.now,
    sleep: async (ms: number) => {
      state.log.push(`sleep ${ms}`);
      state.now += ms;
    },
    open: async (): Promise<IndeedSession> => {
      state.opened++;
      state.open++;
      state.maxOpen = Math.max(state.maxOpen, state.open);
      return {
        async html(url, timeoutMs) {
          state.log.push('nav');
          state.urls.push(url);
          state.timeouts.push(timeoutMs);
          await Promise.resolve();
          state.now += opts.navMs ?? 3_000;
          if (opts.fail?.(url, state.urls.length)) throw new Error('Indeed bloqueou o acesso ou mudou o layout');
          return html;
        },
        async close() {
          state.closed++;
          state.open--;
        },
      };
    },
  };
  return { state, deps };
}

describe('indeed connector', () => {
  it('launches one browser for the whole search and closes it', async () => {
    const { state, deps } = fakeBrowser();
    const jobs = await createIndeed(deps).search(filters());
    expect(state.opened).toBe(1);
    expect(state.closed).toBe(1);
    // termo por fora, site por dentro: se o tempo acabar, todo site já teve ao menos uma consulta
    expect(state.urls).toEqual([
      'https://br.indeed.com/jobs?q=react&fromage=7',
      'https://www.indeed.com/jobs?q=react&fromage=7',
      'https://br.indeed.com/jobs?q=node&fromage=7',
      'https://www.indeed.com/jobs?q=node&fromage=7',
    ]);
    expect(jobs).toHaveLength(60);
    expect(jobs.filter((j) => j.country === 'INT')).toHaveLength(30);
    expect(jobs[0].url).toMatch(/^https:\/\/br\.indeed\.com\/viewjob\?jk=/);
    expect(jobs[15].url).toMatch(/^https:\/\/www\.indeed\.com\/viewjob\?jk=/);
  });

  it('pauses about two seconds between navigations and not after the last', async () => {
    const { state, deps } = fakeBrowser();
    await createIndeed(deps).search(filters());
    expect(state.log).toEqual(['nav', 'sleep 2000', 'nav', 'sleep 2000', 'nav', 'sleep 2000', 'nav']);
  });

  it('stops issuing navigations after 45 s and returns what it collected', async () => {
    const { state, deps } = fakeBrowser({ navMs: 20_000 });
    const jobs = await createIndeed(deps).search(filters({ stacks: ['react', 'node', 'python'] }));
    // navegações começam em 0 s, 22 s e 44 s; em 66 s o orçamento já acabou
    expect(state.urls).toHaveLength(3);
    expect(jobs).toHaveLength(45);
    expect(state.closed).toBe(1);
  });

  it('caps every navigation so the whole search ends within 55 s', async () => {
    const { state, deps } = fakeBrowser({ navMs: 20_000 });
    await createIndeed(deps).search(filters());
    expect(state.timeouts).toEqual([55_000, 33_000, 11_000]);
  });

  it('keeps the results of the queries that worked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state, deps } = fakeBrowser({ fail: (_url, n) => n === 1 });
    const jobs = await createIndeed(deps).search(filters());
    expect(jobs).toHaveLength(45);
    expect(state.closed).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('closes the browser and fails when every query failed', async () => {
    const { state, deps } = fakeBrowser({ fail: () => true });
    await expect(createIndeed(deps).search(filters())).rejects.toThrow(/indeed: as 4 consultas falharam.*bloqueou/);
    expect(state.opened).toBe(1);
    expect(state.closed).toBe(1);
  });

  it('fails with the launch error and opens nothing else when Chromium is missing', async () => {
    const { state, deps } = fakeBrowser();
    const connector = createIndeed({
      ...deps,
      open: () => openIndeedSession(async () => {
        throw new Error("browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium\nrun npx playwright install");
      }),
    });
    await expect(connector.search(filters())).rejects.toThrow(/^Indeed precisa do Chromium do Playwright: /);
    expect(state.urls).toEqual([]);
  });

  it('never runs two browsers at once when a retry arrives during a search', async () => {
    const { state, deps } = fakeBrowser();
    const connector = createIndeed(deps);
    const [a, b] = await Promise.all([connector.search(filters()), connector.search(filters())]);
    expect(state.opened).toBe(2);
    expect(state.closed).toBe(2);
    expect(state.maxOpen).toBe(1);
    expect(a).toHaveLength(60);
    expect(b).toHaveLength(60);
  });

  it('reports a search that spent its whole budget waiting for another one', async () => {
    const { state, deps } = fakeBrowser({ navMs: 20_000 });
    const connector = createIndeed(deps);
    const first = connector.search(filters());
    const second = connector.search(filters());
    await expect(second).rejects.toThrow(/Indeed: .*outra busca/);
    expect(await first).toHaveLength(45);
    expect(state.opened).toBe(1);
  });

  it('recovers after a failed search', async () => {
    const { state, deps } = fakeBrowser({ fail: (_url, n) => n <= 4 });
    const connector = createIndeed(deps);
    await expect(connector.search(filters())).rejects.toThrow();
    expect(await connector.search(filters())).toHaveLength(60);
    expect(state.closed).toBe(2);
  });
});

describe('openIndeedSession', () => {
  const fakeChromium = () => {
    const calls = { pages: 0, closed: 0, gotos: [] as [string, number][], waits: [] as number[] };
    const launch = async () => ({
      async newPage(options: { locale: string }) {
        calls.pages++;
        expect(options).toEqual({ locale: 'pt-BR' });
        return {
          async goto(url: string, o: { timeout: number }) {
            calls.gotos.push([url, o.timeout]);
          },
          async waitForSelector(selector: string, o: { timeout: number }) {
            expect(selector).toBe('div.job_seen_beacon');
            calls.waits.push(o.timeout);
            if (calls.gotos.at(-1)?.[0].includes('blocked')) throw new Error('Timeout 20000ms exceeded');
          },
          async content() {
            return '<html>ok</html>';
          },
        };
      },
      async close() {
        calls.closed++;
      },
    });
    return { calls, launch };
  };

  it('explains in Portuguese how to install Chromium when the launch fails', async () => {
    const launch = async () => {
      throw new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1200/chrome\n╔═ Looks like Playwright was just installed ═╗");
    };
    await expect(openIndeedSession(launch)).rejects.toThrow(
      /^Indeed precisa do Chromium do Playwright: .*playwright install chromium.*Executable doesn't exist at \/ms-playwright\/chromium-1200\/chrome\)$/,
    );
  });

  it('reuses one page for every navigation and closes the browser once', async () => {
    const { calls, launch } = fakeChromium();
    const session = await openIndeedSession(launch);
    expect(await session.html('https://br.indeed.com/jobs?q=a', 30_000)).toBe('<html>ok</html>');
    expect(await session.html('https://br.indeed.com/jobs?q=b', 8_000)).toBe('<html>ok</html>');
    await session.close();
    expect(calls.pages).toBe(1);
    expect(calls.closed).toBe(1);
    expect(calls.gotos.map(([url]) => url)).toEqual(['https://br.indeed.com/jobs?q=a', 'https://br.indeed.com/jobs?q=b']);
    // nenhuma espera passa do tempo que a busca ainda tem
    expect(calls.gotos[0][1]).toBeLessThanOrEqual(30_000);
    expect(calls.gotos[1][1]).toBeLessThanOrEqual(8_000);
    expect(calls.waits[1]).toBeLessThanOrEqual(8_000);
  });

  it('reports a page without result cards as a block or layout change', async () => {
    const { launch } = fakeChromium();
    const session = await openIndeedSession(launch);
    await expect(session.html('https://br.indeed.com/blocked', 30_000)).rejects.toThrow('Indeed bloqueou o acesso ou mudou o layout');
  });
});
