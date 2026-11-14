import { describe, expect, it } from 'vitest';
import { DASHBOARD_PERIODS, DASHBOARD_PERIOD_LABELS, DEFAULT_DASHBOARD_PERIOD, periodSince, scoreBand } from './dashboard-constants';

const DAY = 86_400_000;

describe('dashboard contract', () => {
  it('computes the start of each period', () => {
    expect(periodSince('7', 10 * DAY)).toBe(3 * DAY);
    expect(periodSince('all', 10 * DAY)).toBeNull();
  });
  it.each([[95, '90+'], [90, '90+'], [89, '80-89'], [70, '70-79'], [69, 'below-70'], [null, 'none']] as const)('puts %s in band %s', (s, b) => expect(scoreBand(s)).toBe(b));
  it('labels every period', () => expect(Object.keys(DASHBOARD_PERIOD_LABELS)).toEqual([...DASHBOARD_PERIODS]));
  it('defaults to 30 days', () => expect(DEFAULT_DASHBOARD_PERIOD).toBe('30'));
});
