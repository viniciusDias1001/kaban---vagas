import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapRemoteOk } from './remoteok';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/remoteok.json', import.meta.url), 'utf8'));

describe('mapRemoteOk', () => {
  it('skips the legal notice and maps real jobs', () => {
    const real = fixture.filter((x: { position?: string }) => x.position);
    const jobs = mapRemoteOk(fixture);
    expect(jobs.length).toBe(real.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('remoteok');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
