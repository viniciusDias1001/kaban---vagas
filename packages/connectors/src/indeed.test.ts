import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { indeedTargets, indeedUrl, parseIndeed } from './indeed';

const html = readFileSync(new URL('../fixtures/indeed.html', import.meta.url), 'utf8');
const BR = { domain: 'br.indeed.com', country: 'BR' as const, query: 'react' };

describe('parseIndeed', () => {
  it('extracts valid jobs from a results page', () => {
    const jobs = parseIndeed(html, BR);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('indeed');
      expect(j.url).toBe(`https://br.indeed.com/viewjob?jk=${j.externalId}`);
      expect(j.country).toBe('BR');
      expect(j.location).not.toBe('');
      expect(j.postedAt).toBeNull();
    }
  });

  it('derives remote from the card location and title', () => {
    const jobs = parseIndeed(html, BR);
    for (const j of jobs) {
      expect(j.remote, `${j.title} @ ${j.location}`).toBe(/home office|remot/i.test(`${j.title} ${j.location}`));
    }
    const byId = Object.fromEntries(jobs.map((j) => [j.externalId, j]));
    expect(byId['34de5dbc912d64bf']).toMatchObject({ location: 'Home Office', remote: true });
    expect(byId.a31985bbcc6720ef).toMatchObject({ location: 'Home Office in Fortaleza, CE', remote: true });
    expect(byId['5020aa4eaef0bd13']).toMatchObject({ location: 'Barueri, SP', remote: false });
    expect(byId['93806475a5bac126']).toMatchObject({ location: 'São Paulo, SP', remote: false });
    expect(parseIndeed(html.replaceAll('Barueri, SP', 'Remote in Austin, TX'), BR).find((j) => j.externalId === '5020aa4eaef0bd13')?.remote).toBe(true);
  });

  it('returns an empty list for a page without results', () => {
    expect(parseIndeed('<html></html>', BR)).toEqual([]);
  });
});

describe('indeedTargets', () => {
  const br = { domain: 'br.indeed.com', country: 'BR', remoteOnly: false };
  const brRemote = { domain: 'br.indeed.com', country: 'BR', remoteOnly: true };
  const world = { domain: 'www.indeed.com', country: 'INT', remoteOnly: false };
  const worldRemote = { domain: 'www.indeed.com', country: 'INT', remoteOnly: true };

  it('searches Brazil when no region or only brasil is selected', () => {
    expect(indeedTargets([])).toEqual([br]);
    expect(indeedTargets(['brasil'])).toEqual([br]);
  });
  it('searches remote jobs on both sites for remoto alone', () => {
    expect(indeedTargets(['remoto'])).toEqual([brRemote, worldRemote]);
  });
  it('searches the international site for exterior', () => {
    expect(indeedTargets(['exterior'])).toEqual([world]);
  });
  it('does not repeat a site already searched without the remote restriction', () => {
    expect(indeedTargets(['exterior', 'remoto'])).toEqual([brRemote, world]);
    expect(indeedTargets(['brasil', 'remoto'])).toEqual([br, worldRemote]);
    expect(indeedTargets(['brasil', 'exterior', 'remoto'])).toEqual([br, world]);
  });
});

describe('indeedUrl', () => {
  it('adds the remote location only to remote-only targets', () => {
    const plain = new URL(indeedUrl({ domain: 'br.indeed.com', country: 'BR', remoteOnly: false }, 'c#', 7));
    expect(plain.origin + plain.pathname).toBe('https://br.indeed.com/jobs');
    expect(Object.fromEntries(plain.searchParams)).toEqual({ q: 'c#', fromage: '7' });
    const brRemote = new URL(indeedUrl({ domain: 'br.indeed.com', country: 'BR', remoteOnly: true }, 'react', 3));
    expect(Object.fromEntries(brRemote.searchParams)).toEqual({ q: 'react', fromage: '3', l: 'Home Office' });
    const worldRemote = new URL(indeedUrl({ domain: 'www.indeed.com', country: 'INT', remoteOnly: true }, 'react', 3));
    expect(worldRemote.searchParams.get('l')).toBe('Remote');
  });
});
