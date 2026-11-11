import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { createLinkedin, linkedinTargets, linkedinUrl, parseLinkedin } from './linkedin';

const html = readFileSync(new URL('../fixtures/linkedin.html', import.meta.url), 'utf8');
const BR = { country: 'BR' as const, remote: false, query: 'react' };

describe('parseLinkedin', () => {
  it('extracts every card of the guest search html as a valid job', () => {
    const jobs = parseLinkedin(html, BR);
    expect(jobs).toHaveLength(10);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('linkedin');
      expect(j.externalId).toMatch(/^\d+$/);
      expect(j.url).toMatch(/^https:\/\/br\.linkedin\.com\/jobs\/view\/[^?]+$/);
      expect(j.url.endsWith(j.externalId)).toBe(true);
      expect(j.location).toMatch(/Brazil$/);
      expect(j.company).not.toBe('');
      expect(j.postedAt).not.toBeNull();
    }
    expect(jobs[0]).toMatchObject({
      externalId: '4489662428',
      title: 'Senior React Engineer - Remote Work | REF#309388',
      company: 'BairesDev',
      location: 'São Paulo, São Paulo, Brazil',
      postedAt: Date.UTC(2026, 10, 10, 23, 59, 59, 999),
    });
  });

  it('tags the search term only when the title does not already name it', () => {
    const jobs = parseLinkedin(html, BR);
    expect(jobs[0].stacks).toEqual(['react']);
    expect(jobs[4].title).toBe('Desenvolvedor(a) Front-end');
    expect(jobs[4].stacks).toEqual(['react']);
    expect(jobs[7].stacks).toEqual(['react', 'react native']);
  });

  it('reads remote from the card title even on a non-remote query', () => {
    const jobs = parseLinkedin(html, BR);
    // "... Remote Work" / "... Trabalho Remoto" nos quatro primeiros cartões
    expect(jobs.map((j) => j.remote)).toEqual([true, true, true, true, false, false, false, false, false, false]);
  });

  it('marks every card remote on a remote-only query', () => {
    const jobs = parseLinkedin(html, { ...BR, remote: true });
    expect(jobs.every((j) => j.remote)).toBe(true);
  });

  it('takes the country from the card location, not from the query target', () => {
    const jobs = parseLinkedin(html, { country: 'INT', remote: true, query: 'react' });
    expect(jobs.every((j) => j.country === 'BR')).toBe(true);
    const abroad = html.replaceAll('Brazil', 'Portugal');
    const world = parseLinkedin(abroad, { country: 'INT', remote: false, query: 'react' });
    expect(world.every((j) => j.country === 'INT')).toBe(true);
    expect(parseLinkedin(abroad, BR).every((j) => j.country === 'BR')).toBe(true);
  });

  it('returns an empty list for html without cards', () => {
    expect(parseLinkedin('<html></html>', BR)).toEqual([]);
    expect(parseLinkedin('', BR)).toEqual([]);
  });
});

describe('linkedinTargets', () => {
  const brazil = { location: 'Brazil', country: 'BR', remote: false };
  const brazilRemote = { location: 'Brazil', country: 'BR', remote: true };
  const world = { location: 'Worldwide', country: 'INT', remote: false };
  const worldRemote = { location: 'Worldwide', country: 'INT', remote: true };

  it('queries Brazil when no region or only brasil is selected', () => {
    expect(linkedinTargets([])).toEqual([brazil]);
    expect(linkedinTargets(['brasil'])).toEqual([brazil]);
  });
  it('queries remote work in Brazil and worldwide for remoto', () => {
    expect(linkedinTargets(['remoto'])).toEqual([brazilRemote, worldRemote]);
  });
  it('queries worldwide without the remote flag for exterior', () => {
    expect(linkedinTargets(['exterior'])).toEqual([world]);
  });
  it('combines regions without dropping the remote targets', () => {
    expect(linkedinTargets(['exterior', 'remoto'])).toEqual([world, brazilRemote, worldRemote]);
    expect(linkedinTargets(['remoto', 'brasil', 'exterior'])).toEqual([brazil, world, brazilRemote, worldRemote]);
  });
});

describe('linkedinUrl', () => {
  it('builds the guest search url with the remote work-type flag only for remote targets', () => {
    const remote = new URL(linkedinUrl({ location: 'Brazil', country: 'BR', remote: true }, 'c#', 3));
    expect(remote.pathname).toBe('/jobs-guest/jobs/api/seeMoreJobPostings/search');
    expect(Object.fromEntries(remote.searchParams)).toEqual({
      keywords: 'c#', location: 'Brazil', f_TPR: 'r259200', start: '0', f_WT: '2',
    });
    const plain = new URL(linkedinUrl({ location: 'Worldwide', country: 'INT', remote: false }, 'react', 1));
    expect(plain.searchParams.has('f_WT')).toBe(false);
    expect(plain.searchParams.get('f_TPR')).toBe('r86400');
  });
});

describe('linkedin connector', () => {
  const filters = { stacks: ['react', 'node'], levels: [], maxAgeDays: 7 as const, regions: ['remoto' as const] };

  it('queries every target and term, pausing between requests but not after the last', async () => {
    const urls: string[] = [];
    const sleeps: number[] = [];
    const connector = createLinkedin({
      fetchHtml: async (url) => {
        urls.push(url);
        return html;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const jobs = await connector.search(filters);
    expect(urls).toHaveLength(4);
    expect(urls.map((u) => new URL(u).searchParams.get('location'))).toEqual(['Brazil', 'Brazil', 'Worldwide', 'Worldwide']);
    expect(urls.every((u) => new URL(u).searchParams.get('f_WT') === '2')).toBe(true);
    expect(sleeps).toEqual([1500, 1500, 1500]);
    // o mesmo cartão volta em todas as consultas: sai uma vez só
    expect(jobs).toHaveLength(10);
    expect(jobs.every((j) => j.remote && j.country === 'BR')).toBe(true);
  });

  it('keeps the remote flag when the same job comes from a plain and a remote query', async () => {
    const connector = createLinkedin({ fetchHtml: async () => html, sleep: async () => {} });
    const jobs = await connector.search({ ...filters, stacks: ['react'], regions: ['brasil', 'remoto'] });
    expect(jobs).toHaveLength(10);
    expect(jobs.every((j) => j.remote)).toBe(true);
  });
});
