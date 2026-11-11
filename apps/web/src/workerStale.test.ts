import { describe, expect, it } from 'vitest';
import { STALE_AFTER_MS, isWorkerStale } from './workerStale';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const profile = (active: boolean, ageMs: number) => ({ active, createdAt: NOW - ageMs });

describe('isWorkerStale', () => {
  it('is false without profiles, however old the last run is', () => {
    expect(isWorkerStale({ now: NOW, lastFinishedAt: NOW - 10 * STALE_AFTER_MS, profiles: [] })).toBe(false);
    expect(isWorkerStale({ now: NOW, lastFinishedAt: null, profiles: [] })).toBe(false);
  });
  it('is false when every profile is inactive', () => {
    const profiles = [profile(false, 10 * STALE_AFTER_MS), profile(false, MIN)];
    expect(isWorkerStale({ now: NOW, lastFinishedAt: NOW - 10 * STALE_AFTER_MS, profiles })).toBe(false);
    expect(isWorkerStale({ now: NOW, lastFinishedAt: null, profiles })).toBe(false);
  });
  it('follows the last finished run when there is an active profile', () => {
    const profiles = [profile(true, 30 * 24 * 3_600_000)];
    expect(isWorkerStale({ now: NOW, lastFinishedAt: NOW - 30 * MIN, profiles })).toBe(false);
    expect(isWorkerStale({ now: NOW, lastFinishedAt: NOW - STALE_AFTER_MS, profiles })).toBe(false);
    expect(isWorkerStale({ now: NOW, lastFinishedAt: NOW - STALE_AFTER_MS - 1, profiles })).toBe(true);
  });
  it('becomes true as time passes with the same data (idle tab)', () => {
    const input = { lastFinishedAt: NOW, profiles: [profile(true, 0)] };
    expect(isWorkerStale({ ...input, now: NOW + 119 * MIN })).toBe(false);
    expect(isWorkerStale({ ...input, now: NOW + 121 * MIN })).toBe(true);
  });
  it('with no finished run, waits 2 h from the oldest ACTIVE profile', () => {
    expect(isWorkerStale({ now: NOW, lastFinishedAt: null, profiles: [profile(true, 10 * MIN)] })).toBe(false);
    expect(isWorkerStale({ now: NOW, lastFinishedAt: null, profiles: [profile(true, 10 * MIN), profile(true, 3 * 3_600_000)] })).toBe(true);
    // Um perfil inativo antigo não conta.
    expect(isWorkerStale({ now: NOW, lastFinishedAt: null, profiles: [profile(true, 10 * MIN), profile(false, 3 * 3_600_000)] })).toBe(false);
  });
});
