import { afterEach, describe, expect, it } from 'vitest';
import { getConnector, getConnectors } from './index';

afterEach(() => {
  delete process.env.FAKE_CONNECTORS;
});

describe('connector registry', () => {
  it('lists the nine real connectors with unique ids', () => {
    const ids = getConnectors().map((c) => c.id);
    expect(ids).toEqual([
      'gupy', 'remotive', 'remoteok', 'greenhouse', 'lever', 'arbeitnow', 'himalayas', 'linkedin', 'indeed',
    ]);
  });

  it('finds a connector by id', () => {
    expect(getConnector('gupy')?.name).toBe('Gupy');
    expect(getConnector('nope')).toBeUndefined();
  });

  it('exposes only the fake connector when FAKE_CONNECTORS=1', async () => {
    process.env.FAKE_CONNECTORS = '1';
    const list = getConnectors();
    expect(list.map((c) => c.id)).toEqual(['fake']);
    const jobs = await list[0].search({ stacks: [], levels: [], maxAgeDays: 7, regions: [] });
    expect(jobs[0].title).toBe('Fake React Developer');
  });
});
