import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applicationForJob, closeDb, createApplication, requestCancel, transitionApplication, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { requeueTomorrow, settle } from './outcome';
import { NOON, seedJob } from './test-helpers';

// Um gancho na gravação do desfecho: o dono cancela no instante entre a leitura do pedido e a escrita.
let beforeWrite: (() => void) | null = null;
vi.mock('@kv/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@kv/db')>();
  return {
    ...mod,
    transitionApplication: vi.fn((...args: Parameters<typeof mod.transitionApplication>) => {
      const hook = beforeWrite;
      beforeWrite = null;
      hook?.();
      return mod.transitionApplication(...args);
    }),
  };
});

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  beforeWrite = null;
});
afterAll(() => closeDb(db));

async function running(status: 'preparing' | 'submitting' = 'preparing') {
  const job = await seedJob(db);
  const id = (await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'real' }, NOON))!;
  await transitionApplication(db, id, { status }, NOON);
  return { id, jobId: job.id };
}

describe('settle', () => {
  it('never loses a cancel that lands while a run is being recorded', async () => {
    const { id, jobId } = await running();
    let cancel: Promise<boolean> | null = null;
    beforeWrite = () => {
      cancel = requestCancel(db, jobId, NOON);
    };
    // Um erro passageiro devolve a linha à fila: sem o cancelamento, ela rodaria de novo.
    await settle(db, id, { status: 'queued', detail: 'erro', set: { runAfter: NOON + 1 } }, NOON);
    await cancel;
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'cancelled', cancelRequested: false });
  });

  it('honours a cancel that arrived before the result', async () => {
    const { id, jobId } = await running();
    await requestCancel(db, jobId, NOON);
    expect(await settle(db, id, { status: 'dry_run_ready' }, NOON)).toBe('cancelled');
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'cancelled', cancelRequested: false });
  });
});

describe('requeueTomorrow', () => {
  it('never puts back a row that is past the submit click', async () => {
    const { id, jobId } = await running('submitting');
    expect(await requeueTomorrow(db, id, 'limite', NOON, 'America/Sao_Paulo')).toBeNull();
    expect((await applicationForJob(db, jobId))!.status).toBe('submitting');
  });
});
