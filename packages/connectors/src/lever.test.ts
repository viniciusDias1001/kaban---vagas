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
});
