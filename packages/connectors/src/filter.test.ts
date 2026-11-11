import { describe, expect, it } from 'vitest';
import type { NormalizedJob, SearchFilters } from '@kv/shared';
import { detectLevel, detectStacks, matchesFilters } from './filter';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const job = (over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  source: 't', externalId: '1', url: 'https://a.b/1', title: 'Desenvolvedor React Pleno', company: 'Acme',
  location: 'São Paulo', country: 'BR', remote: false, stacks: ['react'], description: '', postedAt: NOW - DAY,
  ...over,
});
const filters = (over: Partial<SearchFilters> = {}): SearchFilters => ({
  stacks: [], levels: [], maxAgeDays: 7, regions: [], ...over,
});

describe('detectLevel', () => {
  it('detects levels in pt and en', () => {
    expect(detectLevel('Desenvolvedor Sênior')).toBe('senior');
    expect(detectLevel('Sr. Backend Engineer')).toBe('senior');
    expect(detectLevel('Dev Júnior')).toBe('junior');
    expect(detectLevel('Engenheiro Pleno')).toBe('pleno');
    expect(detectLevel('Software Engineer')).toBeNull();
  });
});

describe('detectStacks', () => {
  it('finds known stacks without partial matches', () => {
    expect(detectStacks('Senior JavaScript and Node engineer')).toEqual(['node', 'javascript']);
  });
});

describe('matchesFilters', () => {
  it('passes with empty filters', () => {
    expect(matchesFilters(job(), filters(), NOW)).toBe(true);
  });
  it('rejects jobs older than max age but keeps unknown dates', () => {
    expect(matchesFilters(job({ postedAt: NOW - 8 * DAY }), filters(), NOW)).toBe(false);
    expect(matchesFilters(job({ postedAt: null }), filters(), NOW)).toBe(true);
  });
  it('requires at least one stack', () => {
    expect(matchesFilters(job(), filters({ stacks: ['python'] }), NOW)).toBe(false);
    expect(matchesFilters(job(), filters({ stacks: ['python', 'react'] }), NOW)).toBe(true);
  });
  it('rejects a detected level outside the filter, keeps undetected', () => {
    expect(matchesFilters(job(), filters({ levels: ['senior'] }), NOW)).toBe(false);
    expect(matchesFilters(job({ title: 'Desenvolvedor React' }), filters({ levels: ['senior'] }), NOW)).toBe(true);
  });
  it('matches regions', () => {
    expect(matchesFilters(job(), filters({ regions: ['exterior'] }), NOW)).toBe(false);
    expect(matchesFilters(job(), filters({ regions: ['brasil'] }), NOW)).toBe(true);
    expect(matchesFilters(job({ country: 'INT', remote: true }), filters({ regions: ['remoto'] }), NOW)).toBe(true);
  });
});
