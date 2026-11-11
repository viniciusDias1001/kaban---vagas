import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapGreenhouse } from './greenhouse';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/greenhouse.json', import.meta.url), 'utf8'));

describe('mapGreenhouse', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapGreenhouse(fixture, 'gitlab');
    expect(jobs.length).toBe(fixture.jobs.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('greenhouse');
      expect(j.description).not.toMatch(/<\w+[^>]*>/);
      expect(j.description).not.toMatch(/&(lt|gt|amp|quot|nbsp|#\d+);/);
      expect(j.description.length).toBeGreaterThan(200);
      expect(j.remote).toBe(true);
      expect(j.country).toBe('INT');
    }
  });

  it('takes postedAt from first_published', () => {
    const jobs = mapGreenhouse(fixture, 'gitlab');
    expect(jobs[0].postedAt).toBe(Date.parse('2026-07-22T13:38:40-04:00'));
    expect(jobs[4].postedAt).toBe(Date.parse('2026-10-19T05:22:09-04:00'));
  });

  it('decodes entity-escaped html content once, then strips the tags', () => {
    const [j] = mapGreenhouse(
      {
        jobs: [
          {
            id: 1,
            title: 'Dev',
            absolute_url: 'https://x.y/1',
            content: '&lt;p&gt;Hello &amp;amp; bye&lt;/p&gt;&lt;p&gt;a &amp;lt; b&lt;/p&gt;',
          },
        ],
      },
      'acme',
    );
    expect(j.description).toBe('Hello & bye\na < b');
  });
});
