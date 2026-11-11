import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapGupy } from './gupy';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/gupy.json', import.meta.url), 'utf8'));

describe('mapGupy', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapGupy(fixture, 'react');
    expect(jobs.length).toBe(fixture.data.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('gupy');
      expect(j.country).toBe('BR');
      expect(j.stacks).toContain('react');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
