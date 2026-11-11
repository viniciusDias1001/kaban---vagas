import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapArbeitnow } from './arbeitnow';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/arbeitnow.json', import.meta.url), 'utf8'));

describe('mapArbeitnow', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapArbeitnow(fixture);
    expect(jobs.length).toBe(fixture.data.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('arbeitnow');
      expect(j.country).toBe('INT');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
