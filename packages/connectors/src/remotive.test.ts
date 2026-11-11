import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema, type SearchFilters } from '@kv/shared';
import { REMOTIVE_CACHE_MS, REMOTIVE_FEED_URL, createRemotive, mapRemotive } from './remotive';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/remotive.json', import.meta.url), 'utf8'));
const filters = (stacks: string[]): SearchFilters => ({ stacks, levels: [], maxAgeDays: 7, regions: [] });

describe('mapRemotive', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapRemotive(fixture);
    expect(jobs.length).toBe(fixture.jobs.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('remotive');
      expect(j.remote).toBe(true);
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });

  it('reads publication_date, which has no timezone, as UTC', () => {
    expect(fixture.jobs[0].publication_date).toBe('2026-11-08T21:47:58');
    expect(mapRemotive(fixture)[0].postedAt).toBe(Date.UTC(2026, 10, 8, 21, 47, 58));
  });

  it('only lists stacks found in the job itself', () => {
    // A gravação veio de ?search=react, mas nenhuma das vagas é de React.
    expect(mapRemotive(fixture).map((j) => j.stacks)).toEqual([[], [], [], [], []]);
  });
});

describe('remotive connector', () => {
  const setup = () => {
    const state = { now: 1_800_000_000_000, fetches: 0, fail: false };
    const connector = createRemotive({
      now: () => state.now,
      fetchFeed: async () => {
        state.fetches++;
        if (state.fail) throw new Error('HTTP 503');
        return fixture;
      },
    });
    return { state, connector };
  };

  it('asks for the whole feed, without a search term', () => {
    expect(REMOTIVE_FEED_URL).toBe('https://remotive.com/api/remote-jobs');
    expect(REMOTIVE_CACHE_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('fetches the feed once and serves every profile from memory for six hours', async () => {
    const { state, connector } = setup();
    const first = await connector.search(filters(['react', 'node', 'python']));
    expect(first).toEqual(mapRemotive(fixture));
    expect(state.fetches).toBe(1);

    state.now += REMOTIVE_CACHE_MS - 1;
    expect(await connector.search(filters(['go']))).toEqual(first);
    expect(await connector.search(filters([]))).toEqual(first);
    expect(state.fetches).toBe(1);

    state.now += 1;
    expect(await connector.search(filters(['go']))).toEqual(first);
    expect(state.fetches).toBe(2);
  });

  it('shares one request between searches that start together', async () => {
    const { state, connector } = setup();
    const [a, b] = await Promise.all([connector.search(filters(['react'])), connector.search(filters(['node']))]);
    expect(state.fetches).toBe(1);
    expect(a).toEqual(b);
  });

  it('does not let a caller change the cached jobs', async () => {
    const { connector } = setup();
    const first = await connector.search(filters([]));
    first[0].title = 'alterado';
    first[0].stacks.push('alterado');
    first.pop();
    expect(await connector.search(filters([]))).toEqual(mapRemotive(fixture));
  });

  it('does not cache a failure', async () => {
    const { state, connector } = setup();
    state.fail = true;
    await expect(connector.search(filters([]))).rejects.toThrow('HTTP 503');
    state.fail = false;
    expect(await connector.search(filters([]))).toHaveLength(5);
    expect(state.fetches).toBe(2);
  });

  it('keeps separate caches per connector instance', async () => {
    const a = setup();
    const b = setup();
    await a.connector.search(filters([]));
    await b.connector.search(filters([]));
    expect([a.state.fetches, b.state.fetches]).toEqual([1, 1]);
  });
});
