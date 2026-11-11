import { describe, expect, it } from 'vitest';
import type { NormalizedJob } from '@kv/shared';
import { matchesFilters } from './filter';
import { toMs } from './normalize';

describe('toMs', () => {
  it('converts epoch seconds and milliseconds', () => {
    expect(toMs(1_794_402_656)).toBe(1_794_402_656_000);
    expect(toMs(1_794_402_656_000)).toBe(1_794_402_656_000);
  });
  it('returns null for empty or unparseable values', () => {
    expect(toMs(null)).toBeNull();
    expect(toMs(undefined)).toBeNull();
    expect(toMs('')).toBeNull();
    expect(toMs('ontem')).toBeNull();
  });
  it('keeps explicit timezones', () => {
    expect(toMs('2026-11-11T14:39:20.919Z')).toBe(Date.UTC(2026, 10, 11, 14, 39, 20, 919));
    expect(toMs('2026-07-22T13:38:40-04:00')).toBe(Date.UTC(2026, 6, 22, 17, 38, 40));
  });
  it('treats date-only strings as the end of that day in UTC', () => {
    expect(toMs('2026-11-10')).toBe(Date.UTC(2026, 10, 10, 23, 59, 59, 999));
  });
  it('treats ISO strings without a timezone as UTC', () => {
    expect(toMs('2026-11-08T21:47:58')).toBe(Date.UTC(2026, 10, 8, 21, 47, 58));
    expect(toMs('2026-11-08 21:47:58.5')).toBe(Date.UTC(2026, 10, 8, 21, 47, 58, 500));
    expect(toMs('2026-11-08T21:47')).toBe(Date.UTC(2026, 10, 8, 21, 47));
  });
  it('lets a job dated yesterday pass a one-day max age', () => {
    const job: NormalizedJob = {
      source: 'linkedin', externalId: '1', url: 'https://a.b/1', title: 'Dev', company: 'Acme', location: '',
      country: 'BR', remote: false, stacks: [], description: '', postedAt: toMs('2026-11-10'),
    };
    const f = { stacks: [], levels: [], maxAgeDays: 1 as const, regions: [] };
    expect(matchesFilters(job, f, Date.UTC(2026, 10, 11, 20, 0))).toBe(true);
    expect(matchesFilters(job, f, Date.UTC(2026, 10, 12, 0, 0, 1))).toBe(false);
  });
});
