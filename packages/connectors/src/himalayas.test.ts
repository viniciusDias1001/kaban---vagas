import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NormalizedJobSchema, type SearchFilters } from '@kv/shared';
import { matchesFilters } from './filter';
import { createHimalayas, himalayasSearchUrl, mapHimalayas } from './himalayas';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const browse = read('himalayas.json');
const search = read('himalayas-search.json');
const filters = (stacks: string[]): SearchFilters => ({ stacks, levels: [], maxAgeDays: 30, regions: [] });

describe('mapHimalayas', () => {
  it.each([
    ['browse feed', browse],
    ['search endpoint', search],
  ])('maps every job of the %s fixture to a valid normalized job', (_name, fixture) => {
    const jobs = mapHimalayas(fixture);
    expect(jobs.length).toBe(fixture.jobs.length);
    expect(jobs).toHaveLength(5);
    for (const [i, j] of jobs.entries()) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('himalayas');
      expect(j.remote).toBe(true);
      expect(j.externalId).toBe(fixture.jobs[i].guid);
      expect(j.postedAt).toBe(fixture.jobs[i].pubDate * 1000);
      expect(j.description.length).toBeGreaterThan(100);
      expect(j.description).not.toMatch(/<\w+[^>]*>/);
    }
  });

  it('maps the search fixture fields', () => {
    const [first] = mapHimalayas(search);
    expect(first).toMatchObject({
      externalId: 'https://himalayas.app/companies/lemon-io/jobs/senior-react-full-stack-developer',
      title: 'Senior React Full-stack Developer',
      company: 'lemon.io',
      country: 'INT',
      postedAt: 1_794_317_072_000,
    });
    expect(first.url).toMatch(/^https:\/\/himalayas\.app\/companies\/lemon-io\/jobs\/senior-react-full-stack-developer/);
    expect(first.stacks).toContain('react');
  });

  it('does not tag jobs with the search term: only their own text decides the stack filter', () => {
    const jobs = mapHimalayas(search);
    const now = Date.parse('2026-11-11T14:00:00Z');
    for (const [i, j] of jobs.entries()) {
      const raw = search.jobs[i];
      const own = `${raw.title} ${raw.categories.join(' ')} ${raw.description}`;
      const mentions = /(?<![a-z0-9])react(\.?js)?(?![a-z0-9])/i.test(own);
      expect(j.stacks.includes('react'), raw.title).toBe(/(?<![a-z0-9])react(?![a-z0-9])/i.test(`${raw.title} ${raw.categories.join(' ')}`));
      expect(matchesFilters(j, filters(['react']), now), raw.title).toBe(mentions);
    }
    // "Senior UI & UX Designer" veio na busca por react sem ser vaga de React no título
    expect(jobs[1].stacks).not.toContain('react');
  });
});

describe('himalayasSearchUrl', () => {
  it('uses the search endpoint with q, sort=recent and page', () => {
    expect(himalayasSearchUrl('react', 1)).toBe('https://himalayas.app/jobs/api/search?q=react&sort=recent');
    expect(himalayasSearchUrl('c# .net', 2)).toBe('https://himalayas.app/jobs/api/search?q=c%23+.net&sort=recent&page=2');
  });
});

describe('himalayas connector', () => {
  const page = (jobs: unknown[]) => ({ ...search, jobs });

  it('searches each term, two pages each, and merges repeated jobs', async () => {
    const urls: string[] = [];
    const sleeps: number[] = [];
    const connector = createHimalayas({
      fetchJson: async (url) => {
        urls.push(url);
        const u = new URL(url);
        if (u.searchParams.get('q') === 'react') return u.searchParams.has('page') ? page(search.jobs.slice(2)) : page(search.jobs.slice(0, 3));
        return page(browse.jobs.slice(0, 2));
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const jobs = await connector.search(filters(['react', 'node']));
    expect(urls).toEqual([
      'https://himalayas.app/jobs/api/search?q=react&sort=recent',
      'https://himalayas.app/jobs/api/search?q=react&sort=recent&page=2',
      'https://himalayas.app/jobs/api/search?q=node&sort=recent',
      'https://himalayas.app/jobs/api/search?q=node&sort=recent&page=2',
    ]);
    expect(sleeps).toHaveLength(3);
    expect(jobs.map((j) => j.externalId)).toEqual([
      ...search.jobs.map((j: { guid: string }) => j.guid),
      ...browse.jobs.slice(0, 2).map((j: { guid: string }) => j.guid),
    ]);
  });

  it('searches for developer when the profile has no stacks', async () => {
    const urls: string[] = [];
    const connector = createHimalayas({
      fetchJson: async (url) => {
        urls.push(url);
        return page([]);
      },
      sleep: async () => {},
    });
    expect(await connector.search(filters([]))).toEqual([]);
    expect(urls[0]).toBe('https://himalayas.app/jobs/api/search?q=developer&sort=recent');
  });

  it('does not ask for a second page after a short first page', async () => {
    const urls: string[] = [];
    const connector = createHimalayas({
      fetchJson: async (url) => {
        urls.push(url);
        return { ...page(search.jobs.slice(0, 2)), totalCount: 2 };
      },
      sleep: async () => {},
    });
    expect(await connector.search(filters(['cobol']))).toHaveLength(2);
    expect(urls).toHaveLength(1);
  });

  it('keeps what worked when one request fails and throws when all fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const flaky = createHimalayas({
      fetchJson: async () => {
        if (++n === 1) throw new Error('HTTP 500');
        return page(search.jobs);
      },
      sleep: async () => {},
    });
    expect(await flaky.search(filters(['react', 'node']))).toHaveLength(5);
    warn.mockRestore();

    const down = createHimalayas({
      fetchJson: async () => {
        throw new Error('HTTP 500');
      },
      sleep: async () => {},
    });
    await expect(down.search(filters(['react', 'node']))).rejects.toThrow(/himalayas: as 2 consultas falharam.*HTTP 500/);
  });
});
