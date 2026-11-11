import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapLever } from './lever';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/lever.json', import.meta.url), 'utf8'));

describe('mapLever', () => {
  it('maps every fixture posting to a valid normalized job', () => {
    const jobs = mapLever(fixture, 'palantir');
    expect(jobs.length).toBe(fixture.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('lever');
      expect(j.company).toBe('Palantir');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });

  it('derives country and remote from the posting', () => {
    const jobs = mapLever(fixture, 'palantir');
    // fixture: SG hybrid, GB onsite, US remote, GB hybrid, US hybrid
    expect(fixture.map((p: { country: string }) => p.country)).toEqual(['SG', 'GB', 'US', 'GB', 'US']);
    expect(jobs.map((j) => j.country)).toEqual(['INT', 'INT', 'INT', 'INT', 'INT']);
    expect(jobs.map((j) => j.remote)).toEqual([false, false, true, false, false]);
    expect(jobs[0].location).toBe('Singapore, Singapore');
  });

  it('uses the posting country code before guessing from the location', () => {
    const base = fixture[0];
    const country = (over: object) => mapLever([{ ...base, ...over }], 'palantir')[0].country;
    expect(country({ country: 'BR', categories: { location: 'São Paulo' } })).toBe('BR');
    expect(country({ country: 'br', categories: { location: 'Remote' } })).toBe('BR');
    expect(country({ country: 'US', categories: { location: 'Brazil, Indiana' } })).toBe('INT');
    expect(country({ country: undefined, categories: { location: 'Remote - Brazil' } })).toBe('BR');
    expect(country({ country: null, categories: { location: 'Lisbon' } })).toBe('INT');
  });
});
