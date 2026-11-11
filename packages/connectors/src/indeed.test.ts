import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { parseIndeed } from './indeed';

const html = readFileSync(new URL('../fixtures/indeed.html', import.meta.url), 'utf8');

describe('parseIndeed', () => {
  it('extracts valid jobs from a results page', () => {
    const jobs = parseIndeed(html, { domain: 'br.indeed.com', country: 'BR', query: 'react' });
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('indeed');
      expect(j.url).toBe(`https://br.indeed.com/viewjob?jk=${j.externalId}`);
      expect(j.postedAt).toBeNull();
    }
  });

  it('returns an empty list for a page without results', () => {
    expect(parseIndeed('<html></html>', { domain: 'br.indeed.com', country: 'BR', query: 'react' })).toEqual([]);
  });
});
