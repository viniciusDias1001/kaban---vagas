import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapGupy } from './gupy';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/gupy.json', import.meta.url), 'utf8'));

describe('mapGupy', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapGupy(fixture);
    expect(jobs.length).toBe(fixture.data.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('gupy');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });

  it('lists only the stacks named in the job title', () => {
    expect(mapGupy(fixture).map((j) => j.stacks)).toEqual([
      ['react', '.net'],
      ['react', 'node', 'java'],
      ['react'],
      ['react'],
      ['react', 'node'],
    ]);
    const noStack = { ...fixture.data[0], name: 'Analista de Suporte' };
    expect(mapGupy({ data: [noStack] })[0].stacks).toEqual([]);
  });

  it('derives remote from workplaceType', () => {
    // fixture: remote, remote, remote, hybrid (Bogotá), remote
    expect(fixture.data.map((d: { workplaceType: string }) => d.workplaceType)).toEqual([
      'remote', 'remote', 'remote', 'hybrid', 'remote',
    ]);
    expect(mapGupy(fixture).map((j) => j.remote)).toEqual([true, true, true, false, true]);
  });

  it('marks a job with a city but no Brazilian state as international', () => {
    const jobs = mapGupy(fixture);
    expect(jobs.map((j) => j.country)).toEqual(['BR', 'BR', 'BR', 'INT', 'BR']);
    expect(jobs[3].location).toBe('Bogotá, D.c.');
    expect(jobs[0].location).toBe('Brasil');
    const sp = { ...fixture.data[0], city: 'São Paulo', state: 'São Paulo' };
    expect(mapGupy({ data: [sp] })[0]).toMatchObject({ country: 'BR', location: 'São Paulo, São Paulo' });
  });
});
