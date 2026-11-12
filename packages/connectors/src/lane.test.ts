import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDescriptionFetcher } from './detail';
import { createLane } from './lane';
import { createLinkedin } from './linkedin';

const tick = (ms = 2) => new Promise<void>((r) => setTimeout(r, ms));

/** Relógio falso: `sleep` só avança o relógio e anota o pedido. */
function fakeClock(start = 10_000) {
  const clock = { t: start, sleeps: [] as number[] };
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
}

describe('createLane', () => {
  it('runs one piece of work at a time, in the order asked', async () => {
    const lane = createLane();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const work = (n: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      order.push(n);
      active--;
      return n;
    };
    expect(await Promise.all([lane.run(work(1)), lane.run(work(2)), lane.run(work(3))])).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it('waits the minimum interval since the end of the previous work, and only what is left of it', async () => {
    const { clock, now, sleep } = fakeClock();
    const lane = createLane({ minIntervalMs: 1_500, sleep, now });
    const work = async () => {
      clock.t += 200;
    };
    await lane.run(work); // a primeira não espera
    await lane.run(work);
    clock.t += 1_000; // já passou parte do intervalo
    await lane.run(work);
    clock.t += 5_000; // já passou o intervalo todo
    await lane.run(work);
    expect(clock.sleeps).toEqual([1_500, 500]);
  });

  it('does not wait at all with a zero interval', async () => {
    const { clock, now, sleep } = fakeClock();
    const lane = createLane({ minIntervalMs: 0, sleep, now });
    await Promise.all([lane.run(async () => {}), lane.run(async () => {}), lane.run(async () => {})]);
    expect(clock.sleeps).toEqual([]);
  });

  it('keeps going after a rejection, a synchronous throw or a failing sleep: an error never blocks the lane', async () => {
    const { now } = fakeClock();
    let failSleep = false;
    const lane = createLane({
      minIntervalMs: 10,
      now,
      sleep: async () => {
        if (failSleep) throw new Error('sleep quebrou');
      },
    });
    const results = await Promise.allSettled([
      lane.run(async () => {
        throw new Error('HTTP 429');
      }),
      lane.run(() => {
        throw new Error('throw síncrono');
      }),
      lane.run(async () => 'ok'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    failSleep = true;
    await expect(lane.run(async () => 'nunca roda')).rejects.toThrow('sleep quebrou');
    failSleep = false;
    expect(await lane.run(async () => 'segue')).toBe('segue');
  });

  it('counts the interval from the end of a failed request too', async () => {
    const { clock, now, sleep } = fakeClock();
    const lane = createLane({ minIntervalMs: 1_500, sleep, now });
    await lane
      .run(async () => {
        throw new Error('bloqueado');
      })
      .catch(() => {});
    await lane.run(async () => {});
    expect(clock.sleeps).toEqual([1_500]);
  });
});

describe('the LinkedIn lane shared by the search connector and the detail fetch', () => {
  const searchHtml = readFileSync(new URL('../fixtures/linkedin.html', import.meta.url), 'utf8');
  const detailHtml = readFileSync(new URL('../fixtures/linkedin-detail.html', import.meta.url), 'utf8');
  const filters = { stacks: ['react', 'node'], levels: [], maxAgeDays: 7 as const, regions: ['remoto' as const] };
  const job = { source: 'linkedin', externalId: '4489662428', url: 'https://br.linkedin.com/jobs/view/x-4489662428' };

  it('never lets a detail request overlap a search request, and spaces them by the interval', async () => {
    const { clock, now, sleep } = fakeClock();
    const lane = createLane({ minIntervalMs: 1_500, sleep, now });
    let active = 0;
    let maxActive = 0;
    const log: { kind: string; start: number; end: number }[] = [];
    const request = (kind: string, body: string) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const start = clock.t;
      await tick();
      clock.t += 300;
      log.push({ kind, start, end: clock.t });
      active--;
      return body;
    };
    const connector = createLinkedin({ fetchHtml: request('search', searchHtml), sleep: async () => {}, lane });
    const fetchDescription = createDescriptionFetcher({ fetchHtml: request('detail', detailHtml), linkedinLane: lane, env: {} });

    const searching = connector.search(filters);
    await tick(1); // a busca já está na primeira requisição
    const [jobs, first, second] = await Promise.all([searching, fetchDescription(job), fetchDescription(job)]);

    expect(jobs.length).toBeGreaterThan(0);
    expect(first).toBe(second);
    expect(maxActive).toBe(1);
    expect(log.filter((r) => r.kind === 'search')).toHaveLength(4);
    expect(log.filter((r) => r.kind === 'detail')).toHaveLength(2);
    // Os detalhes entraram no meio da busca, e toda requisição começa ao menos 1,5 s depois do fim da anterior.
    expect(log.findIndex((r) => r.kind === 'detail')).toBeLessThan(log.length - 1);
    for (let i = 1; i < log.length; i++) expect(log[i].start - log[i - 1].end).toBeGreaterThanOrEqual(1_500);
  });

  it('frees the lane when a search request fails, so the detail fetch still runs', async () => {
    const lane = createLane();
    const connector = createLinkedin({
      fetchHtml: async () => {
        throw new Error('HTTP 429 em https://www.linkedin.com/...');
      },
      sleep: async () => {},
      lane,
    });
    const fetchDescription = createDescriptionFetcher({ fetchHtml: async () => detailHtml, linkedinLane: lane, env: {} });
    await expect(connector.search(filters)).rejects.toThrow(/HTTP 429/);
    expect(await fetchDescription(job)).toContain('Sobre a vaga');
  });

  it('does not make a request for a search aborted while it waited for the lane', async () => {
    const lane = createLane();
    const controller = new AbortController();
    let release!: () => void;
    const held = lane.run(() => new Promise<void>((r) => (release = r)));
    let calls = 0;
    const connector = createLinkedin({
      fetchHtml: async () => {
        calls++;
        return searchHtml;
      },
      sleep: async () => {},
      lane,
    });
    const searching = connector.search(filters, controller.signal);
    await tick();
    controller.abort();
    release();
    await held;
    await searching.catch(() => {});
    expect(calls).toBe(0);
  });
});
