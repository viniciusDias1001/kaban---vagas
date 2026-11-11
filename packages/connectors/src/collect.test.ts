import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectQueries } from './collect';

afterEach(() => {
  vi.restoreAllMocks();
});

const boom = (msg: string) => async (): Promise<number[]> => {
  throw new Error(msg);
};

describe('collectQueries', () => {
  it('runs the queries in order and concatenates their results', async () => {
    const seen: string[] = [];
    const out = await collectQueries('fonte', ['a', 'b', 'c'], async (q) => {
      seen.push(q);
      return [q, q.toUpperCase()];
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(out).toEqual(['a', 'A', 'b', 'B', 'c', 'C']);
  });

  it('returns nothing for no queries', async () => {
    expect(await collectQueries('fonte', [], boom('x'))).toEqual([]);
  });

  it('keeps earlier and later results when one query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await collectQueries('fonte', [1, 2, 3], async (q) => {
      if (q === 2) throw new Error('HTTP 429');
      return [q];
    });
    expect(out).toEqual([1, 3]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/fonte: 1 de 3 consultas falharam.*HTTP 429/);
  });

  it('counts a query that succeeds with no results as a success', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await collectQueries('fonte', [1, 2], async (q) => {
      if (q === 1) throw new Error('falhou');
      return [];
    });
    expect(out).toEqual([]);
  });

  it('throws when every query failed, naming the source and the first error', async () => {
    let n = 0;
    const run = async (): Promise<number[]> => {
      throw new Error(`erro ${++n}`);
    };
    await expect(collectQueries('fonte', [1, 2, 3], run)).rejects.toThrow(/^fonte: as 3 consultas falharam.*erro 1/);
  });

  it('rethrows the original error when the only query failed', async () => {
    const err = new Error('HTTP 500 em https://x');
    await expect(collectQueries('fonte', [1], async () => { throw err; })).rejects.toBe(err);
  });

  it('pauses between queries but neither before the first nor after the last', async () => {
    const log: string[] = [];
    await collectQueries(
      'fonte',
      ['a', 'b', 'c'],
      async (q) => {
        log.push(q);
        return [];
      },
      { pause: async () => void log.push('pause') },
    );
    expect(log).toEqual(['a', 'pause', 'b', 'pause', 'c']);
  });

  it('stops issuing queries once shouldStop is true and returns what it has', async () => {
    const log: string[] = [];
    const out = await collectQueries(
      'fonte',
      ['a', 'b', 'c'],
      async (q) => {
        log.push(q);
        return [q];
      },
      { pause: async () => void log.push('pause'), shouldStop: () => log.includes('a') },
    );
    expect(out).toEqual(['a']);
    expect(log).toEqual(['a']);
  });

  it('throws only on the attempted queries when stopped early', async () => {
    let calls = 0;
    const run = async (): Promise<number[]> => {
      calls++;
      throw new Error('bloqueado');
    };
    await expect(collectQueries('fonte', [1, 2, 3], run, { shouldStop: () => calls >= 2 })).rejects.toThrow(
      /fonte: as 2 consultas falharam.*bloqueado/,
    );
  });
});
