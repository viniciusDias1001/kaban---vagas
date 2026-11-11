import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapRemotive } from './remotive';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/remotive.json', import.meta.url), 'utf8'));

describe('mapRemotive', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapRemotive(fixture, 'react');
    expect(jobs.length).toBe(fixture.jobs.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('remotive');
      expect(j.remote).toBe(true);
      expect(j.stacks).toContain('react');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
