import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applicationForJob, closeDb, createApplication, transitionApplication, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { WorkClock, buildEngineDeps, type EngineDepsInput, type RunPhase } from './engine-deps';
import { NOON, createFakeBrowser, createRecordingSite, seedJob } from './test-helpers';

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
