import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import type { Connector } from '@kv/connectors';
import { closeDb, enqueueRuns, jobs, runs, searchProfiles, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { createQueue, enqueueAllActive, failStaleRuns, isDue, msUntilNextHour } from './scheduler';

const HOUR = 3_600_000;

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function addProfile(active: boolean, sources = ['a']) {
  const [row] = await db
    .insert(searchProfiles)
    .values({ name: 'P', stacks: [], levels: [], maxAgeDays: 7, regions: [], sources, active, createdAt: 1 })
    .returning();
  return row;
}

const connector: Connector = {
  id: 'a', name: 'A',
  search: async () => [{
    source: 'a', externalId: '1', url: 'https://example.com/1', title: 'Dev', company: 'Acme', location: '',
    country: 'BR', remote: true, stacks: [], description: '', postedAt: null,
  }],
};

describe('isDue', () => {
  it('is due with no successful run, and not due right after one', async () => {
    const profile = await addProfile(true);
    const now = 10 * HOUR;
    expect(await isDue(db, now)).toBe(true);
    await db.insert(runs).values({
      profileId: profile.id, source: 'a', trigger: 'cron', status: 'ok', createdAt: now, finishedAt: now - 60_000,
    });
    expect(await isDue(db, now)).toBe(false);
    expect(await isDue(db, now + HOUR)).toBe(true);
  });

  it('ignores failed and unfinished runs', async () => {
    const profile = await addProfile(true, ['a', 'b']);
    const now = Date.now();
    await db.insert(runs).values([
      { profileId: profile.id, source: 'a', trigger: 'cron', status: 'error', createdAt: now, finishedAt: now },
      { profileId: profile.id, source: 'b', trigger: 'cron', status: 'running', createdAt: now },
    ]);
    expect(await isDue(db)).toBe(true);
  });
});

describe('enqueueAllActive', () => {
  it('queues runs only for active profiles', async () => {
    await addProfile(true, ['a', 'b']);
    await addProfile(false);
    expect(await enqueueAllActive(db)).toBe(2);
    expect((await db.select().from(runs)).every((r) => r.trigger === 'cron')).toBe(true);
  });
});

describe('createQueue', () => {
  const jobOf = (source: string, n = 1) => ({
    source, externalId: String(n), url: `https://example.com/${source}/${n}`, title: `Dev ${source} ${n}`,
    company: 'Acme', location: '', country: 'BR' as const, remote: true, stacks: [], description: '', postedAt: null,
  });

  /** Conector cujas buscas ficam presas até `release()`; registra quantas rodam ao mesmo tempo. */
  function gated(id: string) {
    const waiting: (() => void)[] = [];
    const state = { calls: 0, active: 0, maxActive: 0 };
    const gatedConnector: Connector = {
      id, name: id,
      async search() {
        state.calls++;
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise<void>((r) => waiting.push(r));
        state.active--;
        return [jobOf(id, state.calls)];
      },
    };
    return { connector: gatedConnector, state, release: () => waiting.shift()?.() };
  }

  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 2_000 && !condition(); i++) await new Promise((r) => setTimeout(r, 2));
    expect(condition()).toBe(true);
  };
  const statuses = async () =>
    Object.fromEntries((await db.select().from(runs).orderBy(asc(runs.id))).map((r) => [r.id, r.status]));

  it('executes every queued run', async () => {
    await addProfile(true);
    await enqueueAllActive(db);
    const queue = createQueue(db, () => [connector]);
    expect(await queue.drain()).toBe(1);
    expect((await db.select().from(runs))[0].status).toBe('ok');
    expect(await db.select().from(jobs)).toHaveLength(1);
    expect(await queue.drain()).toBe(0);
  });

  it('runs several sources in parallel without duplicating a job they share', async () => {
    await addProfile(true, ['a', 'b']);
    await enqueueAllActive(db);
    const other: Connector = { id: 'b', name: 'B', search: connector.search };
    expect(await createQueue(db, () => [connector, other]).drain()).toBe(2);
    expect((await db.select().from(runs)).map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it('never overlaps two runs of the same source: the second starts only after the first finishes', async () => {
    await addProfile(true, ['a']);
    await addProfile(true, ['a']);
    await enqueueAllActive(db);
    const a = gated('a');
    const queue = createQueue(db, () => [a.connector]);

    expect((await queue.tick()).started).toBe(1);
    await until(() => a.state.active === 1);
    expect((await queue.tick()).started).toBe(0); // a fonte está ocupada
    expect(await statuses()).toEqual({ 1: 'running', 2: 'queued' });

    a.release();
    await queue.idle();
    expect((await queue.tick()).started).toBe(1);
    await until(() => a.state.active === 1);
    a.release();
    await queue.idle();

    expect(a.state).toMatchObject({ calls: 2, maxActive: 1 });
    expect(await statuses()).toEqual({ 1: 'ok', 2: 'ok' });
  });

  it('overlaps runs of different sources', async () => {
    await addProfile(true, ['a', 'b']);
    await enqueueAllActive(db);
    const a = gated('a');
    const b = gated('b');
    const queue = createQueue(db, () => [a.connector, b.connector]);
    expect((await queue.tick()).started).toBe(2);
    await until(() => a.state.active === 1 && b.state.active === 1);
    expect(queue.inFlightIds().sort()).toEqual([1, 2]);
    a.release();
    b.release();
    await queue.idle();
    expect(await statuses()).toEqual({ 1: 'ok', 2: 'ok' });
  });

  it('starts a manual run on the next tick while a long cron run of another source is still going', async () => {
    const cronProfile = await addProfile(true, ['a']);
    await enqueueRuns(db, cronProfile, 'cron');
    const a = gated('a');
    const b = gated('b');
    const queue = createQueue(db, () => [a.connector, b.connector]);
    await queue.tick();
    await until(() => a.state.active === 1);

    const manualProfile = await addProfile(false, ['b']);
    await enqueueRuns(db, manualProfile, 'manual');
    expect((await queue.tick()).started).toBe(1);
    await until(() => b.state.active === 1);
    expect(a.state.active).toBe(1); // o run horário continua em andamento

    b.release();
    await until(() => queue.inFlightIds().length === 1);
    expect(await statuses()).toEqual({ 1: 'running', 2: 'ok' });
    a.release();
    await queue.idle();
  });

  it('takes manual runs before cron runs and respects the overall concurrency cap', async () => {
    const cronProfile = await addProfile(true, ['a', 'b']);
    await enqueueRuns(db, cronProfile, 'cron'); // runs 1 (a) e 2 (b)
    const manualProfile = await addProfile(false, ['c']);
    await enqueueRuns(db, manualProfile, 'manual'); // run 3 (c)
    const gates = ['a', 'b', 'c'].map(gated);
    const queue = createQueue(db, () => gates.map((g) => g.connector), { maxConcurrent: 2 });

    expect((await queue.tick()).started).toBe(2);
    expect(queue.inFlightIds().sort()).toEqual([1, 3]); // o manual (3) passa na frente do horário (2)
    expect((await queue.tick()).started).toBe(0); // no teto
    await until(() => gates[0].state.active === 1 && gates[2].state.active === 1);
    gates[0].release();
    gates[2].release();
    await queue.idle();
    expect((await queue.tick()).started).toBe(1);
    await until(() => gates[1].state.active === 1);
    gates[1].release();
    await queue.idle();
    expect(await statuses()).toEqual({ 1: 'ok', 2: 'ok', 3: 'ok' });
  });

  it('reaps a stale running run left by a lost database connection, so the source can be queued again', async () => {
    const profile = await addProfile(true);
    const now = 10 * HOUR;
    await db.insert(runs).values({
      profileId: profile.id, source: 'a', trigger: 'cron', status: 'running', createdAt: 1, startedAt: now - 10 * 60_000,
    });
    expect(await enqueueAllActive(db)).toBe(0); // o índice de pendentes bloqueia a fonte

    const queue = createQueue(db, () => [connector], { now: () => now });
    expect(await queue.tick()).toMatchObject({ reaped: 1, started: 0 });
    const [stale] = await db.select().from(runs);
    expect(stale).toMatchObject({ status: 'error', error: 'execução interrompida' });
    expect(stale.finishedAt).toBeTypeOf('number');
    expect(await enqueueAllActive(db)).toBe(1);
  });

  it('leaves a recently started run of another process alone', async () => {
    const profile = await addProfile(true);
    const now = 10 * HOUR;
    await db.insert(runs).values({
      profileId: profile.id, source: 'a', trigger: 'cron', status: 'running', createdAt: 1, startedAt: now - 60_000,
    });
    const queue = createQueue(db, () => [connector], { now: () => now });
    expect((await queue.tick()).reaped).toBe(0);
    expect((await db.select().from(runs))[0].status).toBe('running');
  });

  it('never reaps a run it is executing, however old', async () => {
    await addProfile(true);
    await enqueueAllActive(db);
    const a = gated('a');
    let now = Date.now();
    const queue = createQueue(db, () => [a.connector], { now: () => now });
    await queue.tick();
    await until(() => a.state.active === 1);

    now += 24 * HOUR; // muito além do limite de "abandonado"
    expect((await queue.tick()).reaped).toBe(0);
    expect(await statuses()).toEqual({ 1: 'running' });
    a.release();
    await queue.idle();
    expect(await statuses()).toEqual({ 1: 'ok' });
  });

  it('retries a failed hourly enqueue on the following ticks until it succeeds', async () => {
    await addProfile(true);
    let attempts = 0;
    const logs: string[] = [];
    const queue = createQueue(db, () => [connector], {
      log: (m) => logs.push(m),
      enqueue: async () => {
        if (++attempts <= 2) throw new Error('banco fora do ar');
        return enqueueAllActive(db);
      },
    });

    expect((await queue.tick()).enqueued).toBeNull(); // nada pedido ainda
    expect(attempts).toBe(0);

    queue.requestEnqueue();
    expect(await queue.tick()).toMatchObject({ enqueued: null, started: 0 });
    expect(await queue.tick()).toMatchObject({ enqueued: null, started: 0 });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('banco fora do ar');

    expect(await queue.tick()).toMatchObject({ enqueued: 1, started: 1 });
    await queue.idle();
    expect((await queue.tick()).enqueued).toBeNull(); // pedido atendido: não enfileira de novo
    expect(attempts).toBe(3);
    expect(await statuses()).toEqual({ 1: 'ok' });
  });
});

describe('failStaleRuns', () => {
  it('marks runs left in running state as error', async () => {
    const profile = await addProfile(true);
    await db.insert(runs).values({ profileId: profile.id, source: 'a', trigger: 'cron', status: 'running', createdAt: 1 });
    await failStaleRuns(db);
    const [run] = await db.select().from(runs);
    expect(run).toMatchObject({ status: 'error', error: 'worker reiniciado' });
    expect(run.finishedAt).toBeTypeOf('number');
  });
});

describe('msUntilNextHour', () => {
  it('returns the distance to the next full hour', () => {
    expect(msUntilNextHour(new Date('2026-11-11T10:15:00.000Z').getTime())).toBe(45 * 60_000);
    expect(msUntilNextHour(new Date('2026-11-11T10:00:00.000Z').getTime())).toBe(HOUR);
  });
});
