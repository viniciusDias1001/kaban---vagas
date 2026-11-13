import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applicationForJob, closeDb, createApplication, jobs, transitionApplication, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { buildApp } from './app';
import { seedJob, testAi } from './ai-testing';

let db: Db;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi() });
});
afterAll(() => closeDb(db));

const jobRow = async (id: number) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];
const move = (id: number, payload: object) => app.inject({ method: 'PATCH', url: `/jobs/${id}`, payload });

async function seedApplication(
  status: 'queued' | 'needs_human' | 'filling' | 'dry_run_ready', over: Partial<typeof jobs.$inferInsert> = {}, reason?: 'confirm_submission' | 'question',
) {
  const job = await seedJob(db, over);
  await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'dry_run' });
  if (status !== 'queued') await transitionApplication(db, (await applicationForJob(db, job.id))!.id, { status, reason });
  return job.id;
}

describe('PATCH /jobs/:id with an application', () => {
  it('cancels the application and clears the flag when the owner moves the card', async () => {
    const waiting = await seedApplication('needs_human', { needsHuman: true, needsHumanReason: 'Falta uma resposta.' });
    const queued = await seedApplication('queued');
    expect((await move(waiting, { column: 'selecionadas', position: 0 })).statusCode).toBe(200);
    expect(await jobRow(waiting)).toMatchObject({ needsHuman: false, needsHumanReason: null });
    expect((await applicationForJob(db, waiting))!.status).toBe('cancelled');
    await move(queued, { column: 'selecionadas', position: 1 });
    expect((await applicationForJob(db, queued))!.status).toBe('cancelled');
  });

  it('asks a running application to stop instead of cancelling it', async () => {
    const id = await seedApplication('filling');
    await move(id, { column: 'selecionadas', position: 0 });
    expect(await applicationForJob(db, id)).toMatchObject({ status: 'filling', cancelRequested: true });
  });

  it('settles as applied by the owner, not cancelled, when the card moves to Aplicada or later', async () => {
    const unconfirmed = await seedApplication('needs_human', { needsHuman: true, needsHumanReason: 'Confira no site.' }, 'confirm_submission');
    expect((await move(unconfirmed, { column: 'aplicada', position: 0 })).statusCode).toBe(200);
    const settled = (await applicationForJob(db, unconfirmed))!;
    expect(settled).toMatchObject({ status: 'skipped', reason: 'already_applied' });
    const events = (await app.inject(`/jobs/${unconfirmed}/application`)).json().application.events;
    expect(events.at(-1)).toMatchObject({ status: 'skipped', message: 'Você marcou esta vaga como aplicada.' });
    expect(await jobRow(unconfirmed)).toMatchObject({ column: 'aplicada', appliedBy: 'humano', needsHuman: false });
    // A tentativa de novo é recusada: a vaga já foi aplicada.
    expect((await app.inject({ method: 'POST', url: `/applications/${settled.id}/retry` })).json()).toMatchObject({ error: 'already_applied' });

    const rehearsal = await seedApplication('dry_run_ready');
    await move(rehearsal, { column: 'entrevista', position: 0 });
    expect(await applicationForJob(db, rehearsal)).toMatchObject({ status: 'skipped', reason: 'already_applied' });
    const running = await seedApplication('filling');
    await move(running, { column: 'oferta', position: 0 });
    expect(await applicationForJob(db, running)).toMatchObject({ status: 'filling', cancelRequested: true });
  });

  it('settles the application when the card is already in Aplicada and is "moved" there again', async () => {
    const id = await seedApplication('needs_human', { column: 'aplicada', appliedBy: null }, 'confirm_submission');
    expect((await move(id, { column: 'aplicada', position: 0 })).statusCode).toBe(200);
    expect(await applicationForJob(db, id)).toMatchObject({ status: 'skipped', reason: 'already_applied' });
    expect(await jobRow(id)).toMatchObject({ column: 'aplicada', appliedBy: 'humano' });
  });

  it('leaves the application alone when the card does not change column', async () => {
    const id = await seedApplication('queued', { needsHuman: true, needsHumanReason: 'x' });
    await move(id, { position: 4 });
    expect((await applicationForJob(db, id))!.status).toBe('queued');
    expect(await jobRow(id)).toMatchObject({ needsHuman: true });
  });
});
