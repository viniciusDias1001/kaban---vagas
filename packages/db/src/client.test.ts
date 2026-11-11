import { describe, expect, it } from 'vitest';
import { DbNotMigratedError, retryUntilReady, sslFor } from './client';

describe('sslFor', () => {
  const noEnv = {};

  it('requires TLS for a remote host when the URL does not say otherwise', () => {
    for (const url of [
      'postgresql://postgres.ref:pw@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
      'postgres://u:p@db.example.com/app',
      'postgres://u:p@10.0.0.5:5432/app',
      'postgres://u:p@[2001:db8::1]:5432/app',
      'postgres://u:p@postgres.railway.internal:5432/railway',
    ]) {
      expect(sslFor(url, noEnv), url).toBe('require');
    }
  });

  it('leaves local hosts and single-label Docker service names alone', () => {
    for (const url of [
      'postgres://postgres:postgres@localhost:5433/kanban',
      'postgres://postgres:postgres@LOCALHOST:5433/kanban',
      'postgres://postgres:postgres@127.0.0.1:5433/kanban',
      'postgres://postgres:postgres@[::1]:5433/kanban',
      'postgres://postgres:postgres@host.docker.internal:5433/kanban',
      'postgres://postgres:postgres@postgres:5432/kanban',
      'postgres://postgres:postgres@kv-railway-pg:5432/kanban',
    ]) {
      expect(sslFor(url, noEnv), url).toBeUndefined();
    }
  });

  it('respects an explicit sslmode/ssl in the URL, including disable', () => {
    for (const query of ['sslmode=disable', 'sslmode=require', 'sslmode=verify-full', 'ssl=false', 'ssl=true']) {
      expect(sslFor(`postgres://u:p@db.example.com/app?${query}`, noEnv), query).toBeUndefined();
    }
  });

  it('respects PGSSLMODE and does not choke on a URL it cannot parse', () => {
    expect(sslFor('postgres://u:p@db.example.com/app', { PGSSLMODE: 'disable' })).toBeUndefined();
    expect(sslFor('not a url', noEnv)).toBeUndefined();
  });
});

describe('retryUntilReady', () => {
  /** Relógio falso: `sleep` só avança o tempo. */
  function fakeClock() {
    let t = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => t,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
    };
  }

  it('returns at once when the first check passes', async () => {
    const clock = fakeClock();
    await retryUntilReady(async () => {}, clock);
    expect(clock.waits).toEqual([]);
  });

  it('retries with growing waits until the check passes, reporting each failed attempt', async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    let calls = 0;
    await retryUntilReady(
      async () => {
        if (++calls <= 6) throw new Error(`down ${calls}`);
      },
      { ...clock, onRetry: ({ attempt, waitMs, error }) => seen.push(`${attempt}:${waitMs}:${(error as Error).message}`) },
    );
    expect(calls).toBe(7);
    expect(clock.waits).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    expect(seen[0]).toBe('1:1000:down 1');
    expect(seen).toHaveLength(6);
  });

  it('gives up with the last error after the timeout, never sleeping past the deadline', async () => {
    const clock = fakeClock();
    let calls = 0;
    const failing = retryUntilReady(
      async () => {
        throw new Error(`down ${++calls}`);
      },
      { ...clock, timeoutMs: 20_000 },
    );
    await expect(failing).rejects.toThrow('down 6');
    expect(clock.waits).toEqual([1_000, 2_000, 4_000, 8_000, 5_000]);
    expect(clock.now()).toBe(20_000);
  });

  it('keeps trying for about five minutes by default', async () => {
    const clock = fakeClock();
    await expect(retryUntilReady(async () => Promise.reject(new Error('down')), clock)).rejects.toThrow('down');
    expect(clock.now()).toBe(300_000);
  });

  it('fails fast when the tables are missing: waiting will not fix it', async () => {
    const clock = fakeClock();
    let calls = 0;
    const failing = retryUntilReady(async () => {
      calls++;
      throw new DbNotMigratedError('Banco sem as tabelas jobs: rode pnpm db:migrate.');
    }, clock);
    await expect(failing).rejects.toThrow(/rode pnpm db:migrate/);
    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
  });
});
