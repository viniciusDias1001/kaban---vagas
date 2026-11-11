import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapRemotive } from './remotive';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/remotive.json', import.meta.url), 'utf8'));

describe('mapRemotive', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapRemotive(fixture);
    expect(jobs.length).toBe(fixture.jobs.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('remotive');
      expect(j.remote).toBe(true);
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });

  it('only lists stacks found in the job itself', () => {
    // A gravação veio de ?search=react, mas nenhuma das vagas é de React.
    expect(mapRemotive(fixture).map((j) => j.stacks)).toEqual([[], [], [], [], []]);
  });
});
