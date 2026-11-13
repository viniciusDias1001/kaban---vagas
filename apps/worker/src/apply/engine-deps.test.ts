import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { applicationForJob, applications, closeDb, createApplication, transitionApplication, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { WorkClock, buildEngineDeps, type EngineDepsInput, type RunPhase } from './engine-deps';
import { NOON, createFakeBrowser, createRecordingSite, seedJob } from './test-helpers';

// Para o teste do cancelamento: um gancho logo antes da gravação travada da transição.
vi.mock('@kv/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@kv/db')>();
  return { ...mod, transitionApplication: vi.fn(mod.transitionApplication) };
});

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

/** Uma linha parada numa espera de outra execução (a próxima, depois do abandono), e as dependências da execução velha. */
async function setup(phase: RunPhase) {
  const job = await seedJob(db);
  const id = (await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'real' }, NOON))!;
  await transitionApplication(db, id, { status: 'waiting_human', set: { waitingGate: 'verification_code' } }, NOON);
  const site = createRecordingSite();
  site.variants.form = { gate: () => 'captcha' };
  const browser = createFakeBrowser();
  const state = { phase };
  const deps = buildEngineDeps({
    db, applicationId: id, site, page: await browser.page(), browser, dataDir: '.', mode: 'real', resumePath: 'x.pdf',
    approved: [], aiAnswers: 'off', ctx: {} as EngineDepsInput['ctx'], resolveDeps: {} as EngineDepsInput['resolveDeps'],
    state, clock: new WorkClock(60_000, () => {}), workTimeoutMs: 60_000, humanPollMs: 5, humanWaitMs: 1_000, now: () => NOON,
  });
  return { deps, browser, state, jobId: job.id };
}

describe('a cancel that lands just before a transition', () => {
  const real = async () => (await vi.importActual<typeof import('@kv/db')>('@kv/db')).transitionApplication;
  /** A próxima transição: o dono cancela logo antes da gravação, depois de qualquer leitura feita antes dela. */
  const cancelBeforeNextWrite = async (id: number) => {
    const actual = await real();
    vi.mocked(transitionApplication).mockImplementationOnce(async (...args) => {
      await db.update(applications).set({ cancelRequested: true }).where(eq(applications.id, id));
      return actual(...args);
    });
  };

  it('wins over the submitting claim: the report says no and the click never follows', async () => {
    const { deps, state, jobId } = await setup('pre');
    const id = (await applicationForJob(db, jobId))!.id;
    await transitionApplication(db, id, { status: 'filling', set: { waitingGate: null } }, NOON);
    await cancelBeforeNextWrite(id);
    expect(await deps.report({ status: 'submitting', answers: [] })).toBe(false);
    expect(state.phase).toBe('pre');
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'filling', cancelRequested: true });
  });

  it('wins over a transition before the click too', async () => {
    const { deps, jobId } = await setup('pre');
    const id = (await applicationForJob(db, jobId))!.id;
    await cancelBeforeNextWrite(id);
    expect(await deps.report({ status: 'filling' })).toBe(false);
    expect((await applicationForJob(db, jobId))!.status).toBe('waiting_human');
  });
});

describe('waitHuman of a run that was given up', () => {
  for (const phase of ['aborted', 'abandoned'] as const) {
    it(`returns at once when the run is ${phase}, without touching the browser or the row`, async () => {
      const { deps, browser, jobId } = await setup(phase);
      expect(await deps.waitHuman('captcha')).toBe('timeout');
      expect(browser.calls).toEqual([]);
      expect((await applicationForJob(db, jobId))!.waitingGate).toBe('verification_code');
    });
  }

  it('does not clear the live wait when the run is abandoned during its own wait', async () => {
    const { deps, state, jobId } = await setup('click');
    const waiting = deps.waitHuman('captcha');
    await new Promise((r) => setTimeout(r, 20));
    state.phase = 'abandoned';
    // A próxima execução da mesma linha já está numa espera sua.
    await transitionApplication(db, (await applicationForJob(db, jobId))!.id, { status: 'waiting_human', set: { waitingGate: 'verification_code' } }, NOON);
    expect(await waiting).toBe('timeout');
    expect((await applicationForJob(db, jobId))!.waitingGate).toBe('verification_code');
  });
});
