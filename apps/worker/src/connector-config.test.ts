import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connector, ConnectorConfig } from '@kv/connectors';
import { closeDb, enqueueRuns, runs, searchProfiles, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { createSettingsService } from '@kv/settings';
import { createQueue } from './scheduler';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function queueRun() {
  const [profile] = await db
    .insert(searchProfiles)
    .values({ name: 'P', stacks: [], levels: [], maxAgeDays: 7, regions: [], sources: ['greenhouse'], active: true, createdAt: 1 })
    .returning();
  await enqueueRuns(db, profile, 'manual');
}

/** Conector que só guarda a configuração recebida em cada busca. */
function spy() {
  const seen: (ConnectorConfig | undefined)[] = [];
  const connector: Connector = {
    id: 'greenhouse', name: 'Greenhouse',
    search: async (_filters, _signal, config) => {
      seen.push(config);
      return [];
    },
  };
  return { connector, seen };
}

describe('connector configuration from the settings service', () => {
  it('hands the current company lists to the connector on every run, so a change applies to the next search', async () => {
    let clock = 0;
    const settings = createSettingsService(db, { env: { LEVER_COMPANIES: 'do-ambiente' }, now: () => clock });
    const { connector, seen } = spy();
    const queue = createQueue(db, () => [connector], { run: { connectorConfig: () => settings.connectorConfig() } });

    await queueRun();
    await queue.drain();
    expect(seen).toEqual([{ greenhouseBoards: ['gitlab', 'stripe', 'cloudflare', 'figma'], leverCompanies: ['do-ambiente'] }]);

    // A aba Configurações (outro processo: a API) grava uma lista nova; o worker a enxerga depois do cache.
    await createSettingsService(db).update({ greenhouseBoards: ['acme'] });
    clock += 5_000;
    await queueRun();
    await queue.drain();
    expect(seen[1]).toEqual({ greenhouseBoards: ['acme'], leverCompanies: ['do-ambiente'] });
    expect((await db.select().from(runs)).map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('passes nothing when no configuration source is given, and fails the run when reading it fails', async () => {
    const { connector, seen } = spy();
    await queueRun();
    await createQueue(db, () => [connector]).drain();
    expect(seen).toEqual([undefined]);

    await db.delete(runs);
    await db.delete(searchProfiles);
    await queueRun();
    await createQueue(db, () => [connector], {
      run: { connectorConfig: async () => Promise.reject(new Error('banco fora do ar')) },
    }).drain();
    expect((await db.select().from(runs))[0]).toMatchObject({ status: 'error', error: 'banco fora do ar' });
    expect(seen).toHaveLength(1);
  });
});
