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
    }
  });
});
