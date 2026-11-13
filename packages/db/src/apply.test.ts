import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ApplySiteId, CandidateProfile } from '@kv/shared';
import { closeDb, type Db } from './index';
import {
  applicationQueueCounts, retryApplication, sendAllRehearsals, sendRehearsal, requeueQuestionWaits, settlePendingQuestions,
  waitingApplication, listApplicationEvents, applicationForJob, applyCandidates, applyCountsSince, companyFormsSince, createApplication,
  deleteApplyData, enqueueApplyCommand, finishApplyCommand, listApplications, nextApplyCommand, nextQueuedApplication,
  recoverApplications, recoverApplyCommands, requestCancel, siteState, toApplicationDto, transitionApplication, updateSiteState,
  settleAppliedByOwner, lockApplicationWithJob, applyWorkerState, saveApplyWorkerState, applicationFilterCounts, listJobItems,
} from './apply';
import { deleteAllAiData } from './ai';
import { applications, applyAnswers, applyCommands, candidateProfiles, jobAi, jobs, settings } from './schema';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

let seq = 0;
async function seedJob(extra: Partial<typeof jobs.$inferInsert> = {}) {
  seq += 1;
  const url = `https://example.com/${seq}`;
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: url, url, title: 'Dev', company: 'ACME', location: 'Remoto', country: 'BR',
      remote: true, level: null, stacks: [], description: '', postedAt: null, discoveredAt: 1_000_000, dedupHash: url,
      profileId: null, position: seq, ...extra,
    })
    .returning();
  return row;
}
const create = async (
  site: ApplySiteId = 'fake', trigger: 'auto' | 'manual' = 'auto', now = 1000, jobExtra: Partial<typeof jobs.$inferInsert> = {},
) => {
  const job = await seedJob(jobExtra);
  const id = await createApplication(db, { jobId: job.id, site, trigger, mode: 'real' }, now);
  return { job, id: id! };
};

describe('createApplication / transitionApplication', () => {
  it('creates one application per job and logs the first event', async () => {
    const job = await seedJob();
    const input = { jobId: job.id, site: 'fake' as const, trigger: 'auto' as const, mode: 'real' as const };
    const id = await createApplication(db, input, 1000);
    expect(await createApplication(db, input, 1001)).toBeNull();
    expect(await listApplicationEvents(db, id!)).toEqual([{ status: 'queued', message: null, at: 1000 }]);
  });

  it('never leaves submitted', async () => {
    const { job, id } = await create();
    await transitionApplication(db, id, { status: 'submitted', set: { confirmation: 'ok' } }, 2000);
    expect(await transitionApplication(db, id, { status: 'queued' }, 3000)).toBe(false);
    expect((await applicationForJob(db, job.id))!.status).toBe('submitted');
    expect(await listApplicationEvents(db, id)).toHaveLength(2);
  });

  it('stamps started, submitted and finished times', async () => {
    const { job, id } = await create();
    await transitionApplication(db, id, { status: 'preparing', message: 'começou' }, 2000);
    await transitionApplication(db, id, { status: 'filling' }, 2500);
    let row = (await applicationForJob(db, job.id))!;
    expect(row).toMatchObject({ startedAt: 2000, submittedAt: null, finishedAt: null });
    await transitionApplication(db, id, { status: 'submitted' }, 3000);
    row = (await applicationForJob(db, job.id))!;
    expect(row).toMatchObject({ startedAt: 2000, submittedAt: 3000, finishedAt: 3000 });
    const failed = await create('fake', 'auto', 1);
    await transitionApplication(db, failed.id, { status: 'failed', detail: 'x' }, 4000);
    expect(await applicationForJob(db, failed.job.id)).toMatchObject({ startedAt: null, finishedAt: 4000, detail: 'x' });
  });

  it('applies the set fields and clears reason and detail when omitted', async () => {
    const { job, id } = await create();
    await transitionApplication(db, id, { status: 'needs_human', reason: 'question', detail: 'd', set: { waitingGate: 'captcha', attempts: 2 } }, 2000);
    expect(await applicationForJob(db, job.id)).toMatchObject({ reason: 'question', detail: 'd', waitingGate: 'captcha', attempts: 2 });
    await transitionApplication(db, id, { status: 'queued' }, 2100);
    expect(await applicationForJob(db, job.id)).toMatchObject({ reason: null, detail: null, waitingGate: 'captcha' });
  });

  it('refuses a guarded transition when the status changed, and leaves unguarded ones alone', async () => {
    const { job, id } = await create();
    const picked = await nextQueuedApplication(db, { excludeSites: [] }, 5000);
    expect(picked!.id).toBe(id);
    expect(await requestCancel(db, job.id, 5001)).toBe(true);
    expect(await transitionApplication(db, id, { status: 'preparing', from: ['queued'] }, 5002)).toBe(false);
    expect(await applicationForJob(db, job.id)).toMatchObject({ status: 'cancelled', startedAt: null });
    expect(await listApplicationEvents(db, id)).toHaveLength(2);
    expect(await transitionApplication(db, id, { status: 'queued' }, 5003)).toBe(true);
    expect(await transitionApplication(db, id, { status: 'preparing', from: ['queued'] }, 5004)).toBe(true);
    expect(await applicationForJob(db, job.id)).toMatchObject({ status: 'preparing', startedAt: 5004 });
  });

  it('refuses a transition marked unlessCancelled when the cancel flag is set, under the same lock', async () => {
    const { job, id } = await create();
    await transitionApplication(db, id, { status: 'filling' }, 2000);
    await db.update(applications).set({ cancelRequested: true }).where(eq(applications.id, id));
    expect(await transitionApplication(db, id, { status: 'submitting', from: ['filling'], unlessCancelled: true }, 3000)).toBe(false);
    expect(await applicationForJob(db, job.id)).toMatchObject({ status: 'filling', cancelRequested: true });
    expect(await transitionApplication(db, id, { status: 'cancelled', from: ['filling'] }, 3000)).toBe(true);
  });

  it('returns false for an unknown id', async () => {
    expect(await transitionApplication(db, 999, { status: 'queued' }, 1)).toBe(false);
  });
});

describe('queue reads', () => {
  it('picks manual applications first and skips excluded sites and future run_after', async () => {
    const auto = await create('fake', 'auto', 100);
    const manualLate = await create('fake', 'manual', 300);
    const manualEarly = await create('fake', 'manual', 200);
    const excluded = await create('linkedin', 'manual', 50);
    const future = await create('fake', 'manual', 10);
    await db.update(applications).set({ runAfter: 9000 }).where(eq(applications.id, future.id));
    const picked: number[] = [];
    for (;;) {
      const next = await nextQueuedApplication(db, { excludeSites: ['linkedin'] }, 5000);
      if (!next) break;
      picked.push(next.id);
      await transitionApplication(db, next.id, { status: 'preparing' }, 5000);
    }
    expect(picked).toEqual([manualEarly.id, manualLate.id, auto.id]);
    expect((await nextQueuedApplication(db, { excludeSites: [] }, 5000))!.id).toBe(excluded.id);
    expect((await nextQueuedApplication(db, { excludeSites: ['linkedin'] }, 9000))!.id).toBe(future.id);
  });

  it('lists newest first, filters, and builds a dto without the pdf bytes', async () => {
    const a = await create('fake', 'auto', 100);
    const b = await create('linkedin', 'auto', 200);
    await transitionApplication(db, b.id, {
      status: 'needs_human', reason: 'question',
      set: {
        resumePdf: Buffer.from('pdf'), resumeLang: 'en', resumeFileName: 'cv.pdf',
        pendingQuestions: [{
          question: { id: 'q', label: 'L', help: '', kind: 'text', options: [], required: true, maxLength: null },
          category: 'open', kind: 'unanswered', proposal: null,
        }],
      },
    }, 300);
    const all = await listApplications(db, {});
    expect(all.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(all[0]).toMatchObject({ jobTitle: 'Dev', company: 'ACME', site: 'linkedin', pendingCount: 1, status: 'needs_human' });
    expect(await listApplications(db, { site: 'fake' })).toHaveLength(1);
    expect(await listApplications(db, { status: 'needs_human' })).toHaveLength(1);
    const row = (await applicationForJob(db, b.job.id))!;
    const dto = toApplicationDto(row, await listApplicationEvents(db, b.id));
    expect(dto).toMatchObject({ id: b.id, hasResume: true, resumeFileName: 'cv.pdf', cancelRequested: false });
    expect(toApplicationDto({ ...row, cancelRequested: true }, []).cancelRequested).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('resumePdf');
    expect(dto.events).toHaveLength(2);
  });
});

describe('lists, counts and the board', () => {
  /** `n` candidaturas no estado dado, criadas em lote (vaga e candidatura), com `createdAt` crescente a partir de `from`. */
  async function bulk(n: number, status: 'skipped' | 'dry_run_ready' | 'queued' | 'cancelled', from: number) {
    const base = seq;
    seq += n;
    const rows = await db.insert(jobs).values(Array.from({ length: n }, (_, i) => {
      const url = `https://example.com/bulk/${base + i}`;
      return {
        source: 'gupy', externalId: url, url, title: 'Dev', company: 'ACME', location: 'Remoto', country: 'BR' as const,
        remote: true, stacks: [], description: '', discoveredAt: 1, dedupHash: url, position: base + i,
      };
    })).returning({ id: jobs.id });
    return db.insert(applications).values(rows.map((r, i) => ({
      jobId: r.id, site: 'fake' as const, status, trigger: 'auto' as const, mode: 'real' as const, createdAt: from + i,
    }))).returning({ id: applications.id, jobId: applications.jobId });
  }

  it('counts every filter over all rows and lists the 200 newest of one filter', async () => {
    const old = await bulk(205, 'cancelled', 1000);
    await bulk(3, 'skipped', 5000);
    await bulk(2, 'dry_run_ready', 6000);
    const running = await create();
    await transitionApplication(db, running.id, { status: 'filling' });
    expect(await applicationFilterCounts(db)).toEqual({ active: 1, needs_human: 0, rehearsals: 2, submitted: 0, skipped: 208 });
    const skipped = await listApplications(db, { filter: 'skipped' });
    expect(skipped).toHaveLength(200);
    expect(skipped.every((r) => ['skipped', 'cancelled', 'failed'].includes(r.status))).toBe(true);
    expect(skipped.map((r) => r.id)).not.toContain(old[0].id); // os mais antigos ficam de fora
    expect(await listApplications(db, { filter: 'rehearsals' })).toHaveLength(2);
    expect((await listApplications(db, { filter: 'active' })).map((r) => r.id)).toEqual([running.id]);
  });

  it('sends exactly the listed rows that are still rehearsals, and counts the rest as skipped', async () => {
    const [a, b, c] = await bulk(3, 'dry_run_ready', 1000);
    const [d] = await bulk(1, 'queued', 1000);
    const [applied] = await bulk(1, 'dry_run_ready', 1000);
    await db.update(jobs).set({ column: 'aplicada', appliedBy: 'humano' }).where(eq(jobs.id, applied.jobId));
    expect(await sendAllRehearsals(db, [a.id, b.id, d.id, applied.id, 999_999], 2000)).toEqual({ queued: 2, skipped: 3 });
    expect(await applicationForJob(db, a.jobId)).toMatchObject({ status: 'queued', mode: 'real' });
    expect((await applicationForJob(db, c.jobId))!.status).toBe('dry_run_ready');
    expect((await applicationForJob(db, applied.jobId))!.status).toBe('dry_run_ready');
    expect(await sendAllRehearsals(db, [], 2000)).toEqual({ queued: 0, skipped: 0 });
  });

  it('lists the board with each job application status and without the heavy columns', async () => {
    const plain = await seedJob();
    const { job, id } = await create();
    await transitionApplication(db, id, { status: 'needs_human', reason: 'question' });
    const items = await listJobItems(db);
    expect(items.map((i) => [i.id, i.applicationStatus])).toEqual([[plain.id, null], [job.id, 'needs_human']]);
    expect(items[0]).not.toHaveProperty('description');
    expect(items[0]).not.toHaveProperty('dedupHash');
    expect(items[0]).toMatchObject({ title: 'Dev', column: 'descobertas', appliedBy: null });
    expect((await listJobItems(db, eq(jobs.id, job.id))).map((i) => i.id)).toEqual([job.id]);
  });
});

describe('counts', () => {
  it('counts forms and views per site since a moment', async () => {
    const mk = async (site: ApplySiteId, form: number | null, view: number | null) => {
      const { id } = await create(site);
      await db.update(applications).set({ formOpenedAt: form, viewedAt: view }).where(eq(applications.id, id));
    };
    await mk('linkedin', 900, null);
    await mk('linkedin', 1100, 1100);
    await mk('linkedin', null, 1200);
    await mk('fake', 1300, null);
    expect(await applyCountsSince(db, 1000)).toEqual({
      forms: expect.objectContaining({ linkedin: 1, fake: 1, greenhouse: 0, lever: 0 }),
      views: expect.objectContaining({ linkedin: 2, fake: 0 }),
      total: 2,
    });
  });

  it('counts company forms ignoring case and spaces', async () => {
    const a = await create('fake', 'auto', 1, { company: 'Acme  Corp' });
    const b = await create('fake', 'auto', 1, { company: ' acme corp ' });
    const c = await create('fake', 'auto', 1, { company: 'Other' });
    await create('fake', 'auto', 1, { company: 'ACME CORP' }); // sem formulário aberto
    for (const x of [a, b, c]) await db.update(applications).set({ formOpenedAt: 2000 }).where(eq(applications.id, x.id));
    await db.update(applications).set({ formOpenedAt: 500 }).where(eq(applications.id, b.id));
    expect(await companyFormsSince(db, 'ACME corp', 1000)).toBe(1);
    expect(await companyFormsSince(db, 'ACME corp', 100)).toBe(2);
  });
});

describe('applyCandidates', () => {
  const profileData = {} as CandidateProfile;
  const scored = async (
    score: number,
    o: { jobExtra?: Partial<typeof jobs.$inferInsert>; version?: number; state?: 'ok' | 'error' } = {},
  ) => {
    const job = await seedJob({ discoveredAt: 1_000_000, ...o.jobExtra });
    await db.insert(jobAi).values({ jobId: job.id, score, tier1State: o.state ?? 'ok', tier1ProfileVersion: o.version ?? 2 });
    return job;
  };

  it('lists only eligible candidates, best score first', async () => {
    await db.insert(candidateProfiles).values({ lang: 'en', data: profileData, origin: 'extraido', version: 1, updatedAt: 1 });
    await db.insert(candidateProfiles).values({ lang: 'pt-BR', data: profileData, origin: 'traduzido', version: 2, updatedAt: 1 });
    const discoveredAfter = 900_000;
    await scored(70);
    const best = await scored(91);
    await scored(69);
    await scored(95, { jobExtra: { column: 'selecionadas' } });
    await scored(95, { jobExtra: { appliedBy: 'humano' } });
    const has = await scored(95);
    await createApplication(db, { jobId: has.id, site: 'fake', trigger: 'auto', mode: 'real' }, 1);
    await scored(95, { jobExtra: { discoveredAt: 100 } });
    await scored(95, { version: 1 });
    await scored(95, { state: 'error' });
    await seedJob({ discoveredAt: 1_000_000 }); // sem nota
    const result = await applyCandidates(db, { minScore: 70, discoveredAfter, limit: 10 });
    expect(result.map((c) => c.score)).toEqual([91, 70]);
    expect(result[0]).toEqual({
      jobId: best.id, source: 'gupy', url: best.url, externalId: best.externalId, company: 'ACME', title: 'Dev', score: 91,
    });
    expect(await applyCandidates(db, { minScore: 70, discoveredAfter, limit: 1 })).toHaveLength(1);
  });

  it('returns nothing without a profile', async () => {
    await scored(90);
    expect(await applyCandidates(db, { minScore: 70, discoveredAfter: 0, limit: 10 })).toEqual([]);
  });
});

describe('recovery and cancellation', () => {
  it('recovers interrupted applications without ever resending', async () => {
    const filling = await create();
    const submitting = await create();
    const done = await create();
    await transitionApplication(db, filling.id, { status: 'filling' }, 2000);
    await transitionApplication(db, submitting.id, { status: 'submitting' }, 2000);
    await transitionApplication(db, done.id, { status: 'submitted' }, 2000);
    expect(await recoverApplications(db, 5000)).toEqual({ requeued: 1, unconfirmed: [submitting.id] });
    expect(await applicationForJob(db, submitting.job.id)).toMatchObject({ status: 'needs_human', reason: 'confirm_submission' });
    expect(await applicationForJob(db, filling.job.id)).toMatchObject({ status: 'queued' });
    expect(await applicationForJob(db, done.job.id)).toMatchObject({ status: 'submitted' });
    expect(await listApplicationEvents(db, submitting.id)).toHaveLength(3);
  });

  it('requeues every state stored only before the click and clears the live wait', async () => {
    const preparing = await create();
    const waiting = await create();
    const submitting = await create();
    await transitionApplication(db, preparing.id, { status: 'preparing' }, 2000);
    await transitionApplication(db, waiting.id, { status: 'waiting_human', set: { waitingGate: 'captcha', runAfter: 9000 } }, 2000);
    await transitionApplication(db, submitting.id, { status: 'submitting', set: { waitingGate: 'login' } }, 2000);
    expect(await recoverApplications(db, 5000)).toEqual({ requeued: 2, unconfirmed: [submitting.id] });
    expect(await applicationForJob(db, preparing.job.id)).toMatchObject({ status: 'queued' });
    expect(await applicationForJob(db, waiting.job.id)).toMatchObject({ status: 'queued', waitingGate: null, runAfter: null });
    expect(await applicationForJob(db, submitting.job.id)).toMatchObject({
      status: 'needs_human', reason: 'confirm_submission', waitingGate: null,
    });
  });

  it('cancels a queued application at once and flags a running one', async () => {
    const queued = await create();
    const running = await create();
    const submitted = await create();
    await transitionApplication(db, running.id, { status: 'filling' }, 2000);
    await transitionApplication(db, submitted.id, { status: 'submitted' }, 2000);
    expect(await requestCancel(db, queued.job.id, 3000)).toBe(true);
    expect(await applicationForJob(db, queued.job.id)).toMatchObject({ status: 'cancelled', finishedAt: 3000 });
    const parked = await create();
    const dry = await create();
    const sending = await create();
    await transitionApplication(db, parked.id, { status: 'needs_human', reason: 'question' }, 2000);
    await transitionApplication(db, dry.id, { status: 'dry_run_ready' }, 2000);
    await transitionApplication(db, sending.id, { status: 'submitting' }, 2000);
    expect(await requestCancel(db, parked.job.id, 3000)).toBe(true);
    expect(await applicationForJob(db, parked.job.id)).toMatchObject({ status: 'cancelled', finishedAt: 3000 });
    expect(await requestCancel(db, dry.job.id, 3000)).toBe(true);
    expect(await applicationForJob(db, dry.job.id)).toMatchObject({ status: 'cancelled' });
    expect(await requestCancel(db, sending.job.id, 3000)).toBe(true);
    expect(await applicationForJob(db, sending.job.id)).toMatchObject({ status: 'submitting', cancelRequested: true });
    expect(await requestCancel(db, queued.job.id, 3000)).toBe(false);
    expect(await requestCancel(db, running.job.id, 3000)).toBe(true);
    expect(await applicationForJob(db, running.job.id)).toMatchObject({ status: 'filling', cancelRequested: true });
    expect(await requestCancel(db, submitted.job.id, 3000)).toBe(false);
    expect(await requestCancel(db, 12345, 3000)).toBe(false);
  });
});

describe('commands and site state', () => {
  it('keeps one pending command per kind and site', async () => {
    const first = await enqueueApplyCommand(db, 'check_session', 'linkedin', 10);
    expect(first).not.toBeNull();
    expect(await enqueueApplyCommand(db, 'check_session', 'linkedin', 11)).toBeNull();
    expect(await enqueueApplyCommand(db, 'check_session', 'lever', 11)).not.toBeNull();
    expect(await enqueueApplyCommand(db, 'close_browser', null, 11)).not.toBeNull();
    expect(await enqueueApplyCommand(db, 'close_browser', null, 12)).toBeNull();
    const next = (await nextApplyCommand(db))!;
    expect(next).toMatchObject({ id: first, status: 'running' });
    await finishApplyCommand(db, next.id, { ok: false, message: 'falhou' }, 20);
    const [row] = await db.select().from(applyCommands).where(eq(applyCommands.id, next.id));
    expect(row).toMatchObject({ status: 'error', result: 'falhou', finishedAt: 20 });
    expect(await enqueueApplyCommand(db, 'check_session', 'linkedin', 30)).not.toBeNull();
  });

  it('recovers commands left running by a crash', async () => {
    await enqueueApplyCommand(db, 'open_login', 'lever', 10);
    await nextApplyCommand(db);
    expect(await enqueueApplyCommand(db, 'open_login', 'lever', 11)).toBeNull();
    expect(await recoverApplyCommands(db, 50)).toBe(1);
    const [row] = await db.select().from(applyCommands);
    expect(row).toMatchObject({ status: 'error', result: 'interrompido: o worker reiniciou', finishedAt: 50 });
    expect(await enqueueApplyCommand(db, 'open_login', 'lever', 60)).not.toBeNull();
    expect(await recoverApplyCommands(db, 70)).toBe(0);
  });

  it('returns null when there is no command', async () => {
    expect(await nextApplyCommand(db)).toBeNull();
  });

  it('creates the site row with defaults and patches it', async () => {
    expect(await siteState(db, 'lever')).toMatchObject({ site: 'lever', session: 'unknown', paused: false, consecutiveFailures: 0 });
    await updateSiteState(db, 'lever', { paused: true, pauseReason: 'brake', consecutiveFailures: 3 });
    expect(await siteState(db, 'lever')).toMatchObject({ paused: true, pauseReason: 'brake', consecutiveFailures: 3 });
  });
});

describe('the worker state', () => {
  it('is null until a worker reports, then reads back the last report', async () => {
    expect(await applyWorkerState(db)).toBeNull();
    await saveApplyWorkerState(db, { available: false, reason: 'sem navegador' }, 1000);
    expect(await applyWorkerState(db)).toEqual({ available: false, reason: 'sem navegador', seenAt: 1000 });
    await saveApplyWorkerState(db, { available: true, reason: null }, 2000);
    expect(await applyWorkerState(db)).toEqual({ available: true, reason: null, seenAt: 2000 });
  });

  it('survives the deletion of the AI data and reads a damaged row as null', async () => {
    await saveApplyWorkerState(db, { available: true, reason: null }, 1000);
    await deleteAllAiData(db);
    expect(await applyWorkerState(db)).not.toBeNull();
    await db.update(settings).set({ value: { available: 'yes' } });
    expect(await applyWorkerState(db)).toBeNull();
  });
});

describe('deleteApplyData', () => {
  it('deletes personal data but keeps status and dates', async () => {
    const { job, id } = await create();
    await transitionApplication(db, id, {
      status: 'submitted',
      set: {
        confirmation: 'ok', contactEmail: 'a@example.com', resumePdf: Buffer.from('x'), shots: { filled: 'f.png' },
        answers: [{
          questionId: 'q', value: 'v', source: 'bank', category: 'open', basis: [], bankAnswerId: null,
          label: 'L', help: '', kind: 'text', options: [], required: true,
        }],
      },
    }, 2000);
    await db.insert(applyAnswers).values({ question: 'q', normalized: 'q', kind: 'text', createdAt: 1, updatedAt: 1 });
    await db.update(applications).set({ approvedAnswers: (await applicationForJob(db, job.id))!.answers });
    await deleteApplyData(db);
    expect(await applicationForJob(db, job.id)).toMatchObject({
      status: 'submitted', submittedAt: 2000, answers: [], approvedAnswers: [], pendingQuestions: [], resumePdf: null, contactEmail: null,
      confirmation: null, shots: {},
    });
    expect(await db.select().from(applyAnswers)).toEqual([]);
  });

  it('also empties the details and the event texts, and cancels the applications waiting on questions', async () => {
    const sent = await create();
    await transitionApplication(db, sent.id, { status: 'submitted', message: 'Obrigado pela candidatura, Fulano!' }, 2000);
    const failed = await create();
    await transitionApplication(db, failed.id, { status: 'failed', detail: 'erro com o currículo de Fulano' }, 2000);
    const asked = await create();
    await transitionApplication(db, asked.id, {
      status: 'needs_human', reason: 'question', detail: 'uma pergunta precisa de você',
      set: { pendingQuestions: [{ question: { id: 'q', label: 'L', help: '', kind: 'text', options: [], required: true, maxLength: null }, category: 'open', kind: 'unanswered', proposal: null }] },
    }, 2000);
    const captcha = await create();
    await transitionApplication(db, captcha.id, { status: 'needs_human', reason: 'captcha', detail: 'resolva' }, 2000);
    await db.update(jobs).set({ needsHuman: true, needsHumanReason: 'x' });

    await deleteApplyData(db, 3000);

    expect(await applicationForJob(db, failed.job.id)).toMatchObject({ status: 'failed', detail: null });
    expect(await applicationForJob(db, asked.job.id)).toMatchObject({
      status: 'cancelled', reason: null, detail: null, pendingQuestions: [], finishedAt: 3000,
    });
    expect((await db.select().from(jobs).where(eq(jobs.id, asked.job.id)))[0]).toMatchObject({ needsHuman: false, needsHumanReason: null });
    expect(await applicationForJob(db, captcha.job.id)).toMatchObject({ status: 'needs_human', reason: 'captcha', detail: null });
    expect((await db.select().from(jobs).where(eq(jobs.id, captcha.job.id)))[0]).toMatchObject({ needsHuman: true });
    const sentEvents = await listApplicationEvents(db, sent.id);
    expect(sentEvents.map((e) => e.message)).toEqual([null, null]);
    expect((await listApplicationEvents(db, asked.id)).at(-1)).toEqual({
      status: 'cancelled', message: 'Os dados de IA foram apagados: a candidatura foi cancelada.', at: 3000,
    });
  });

  it('runs with deleteAllAiData', async () => {
    const { job } = await create();
    await db.update(applications).set({ contactEmail: 'a@example.com' }).where(eq(applications.jobId, job.id));
    await deleteAllAiData(db);
    expect((await applicationForJob(db, job.id))!.contactEmail).toBeNull();
  });
});

describe('queue counts and the live wait', () => {
  it('counts queued and needs_human rows and finds the live wait', async () => {
    const a = await create();
    await create();
    const c = await create();
    expect(await applicationQueueCounts(db)).toEqual({ queued: 3, needsHuman: 0, running: 0 });
    expect(await waitingApplication(db)).toBeNull();
    await transitionApplication(db, a.id, { status: 'needs_human', reason: 'question' });
    await transitionApplication(db, c.id, { status: 'waiting_human', set: { waitingGate: 'captcha' } });
    expect(await applicationQueueCounts(db)).toEqual({ queued: 1, needsHuman: 1, running: 1 });
    expect(await waitingApplication(db)).toEqual({ applicationId: c.id, jobId: c.job.id, gate: 'captcha' });
  });

  it('shows a wait after the submit click, while the row stays submitting, and only a row with a gate', async () => {
    const a = await create();
    const b = await create();
    await transitionApplication(db, a.id, { status: 'waiting_human' });
    expect(await waitingApplication(db)).toBeNull();
    await transitionApplication(db, b.id, { status: 'submitting', set: { waitingGate: 'verification_code' } });
    expect(await waitingApplication(db)).toEqual({ applicationId: b.id, jobId: b.job.id, gate: 'verification_code' });
    await transitionApplication(db, b.id, { status: 'needs_human', reason: 'confirm_submission', set: { waitingGate: 'captcha' } });
    expect(await waitingApplication(db)).toBeNull();
  });
});

describe('retryApplication', () => {
  it('requeues the stopped states and refuses a sent, running or unconfirmed one', async () => {
    const { id, job } = await create();
    await db.update(jobs).set({ needsHuman: true, needsHumanReason: 'x' }).where(eq(jobs.id, job.id));
    for (const status of ['needs_human', 'failed', 'skipped', 'cancelled'] as const) {
      await transitionApplication(db, id, { status, set: { attempts: 2, runAfter: 5 } });
      expect(await retryApplication(db, id)).toBe('queued');
      expect(await applicationForJob(db, job.id)).toMatchObject({ status: 'queued', attempts: 0, runAfter: null, approvedAnswers: [] });
    }
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0]).toMatchObject({ needsHuman: false });
    expect(await retryApplication(db, id)).toBe('not_retryable'); // já na fila
    await transitionApplication(db, id, { status: 'filling' });
    expect(await retryApplication(db, id)).toBe('in_progress');
    await transitionApplication(db, id, { status: 'needs_human', reason: 'confirm_submission' });
    expect(await retryApplication(db, id)).toBe('confirm_submission');
    expect((await applicationForJob(db, job.id))!.status).toBe('needs_human');
    await transitionApplication(db, id, { status: 'submitted' });
    expect(await retryApplication(db, id)).toBe('sent');
    expect(await retryApplication(db, 999_999)).toBe('not_found');
  });
});

describe('retryApplication after the gate', () => {
  it('brings back as manual an application the gate skipped, and keeps the trigger of every other retry', async () => {
    const cases = [
      { status: 'skipped', reason: 'not_eligible', trigger: 'manual' },
      { status: 'skipped', reason: 'below_min_score', trigger: 'manual' },
      { status: 'skipped', reason: 'closed', trigger: 'auto' },
      { status: 'failed', reason: null, trigger: 'auto' },
      { status: 'needs_human', reason: 'question', trigger: 'auto' },
    ] as const;
    for (const c of cases) {
      const { id, job } = await create('fake', 'auto');
      await transitionApplication(db, id, { status: c.status, reason: c.reason });
      expect(await retryApplication(db, id)).toBe('queued');
      expect(await applicationForJob(db, job.id)).toMatchObject({ status: 'queued', trigger: c.trigger });
    }
  });
});

describe('sendRehearsal / sendAllRehearsals', () => {
  const answer = (id: string, value: string) => ({
    questionId: id, value, source: 'bank' as const, category: 'profile_fact' as const, basis: [], bankAnswerId: null,
    label: id, help: '', kind: 'text' as const, options: [], required: true,
  });
  it('queues the rehearsal for real and copies its answers to approved_answers', async () => {
    const { id, job } = await create('fake', 'auto');
    const answers = [answer('q1', '20000')];
    await transitionApplication(db, id, { status: 'dry_run_ready', set: { answers, mode: 'dry_run' } });
    expect(await sendRehearsal(db, id)).toBe('queued');
    expect(await applicationForJob(db, job.id)).toMatchObject({ status: 'queued', mode: 'real', answers, approvedAnswers: answers, finishedAt: null });
    expect(await sendRehearsal(db, id)).toBe('not_rehearsal');
    expect(await sendRehearsal(db, 999_999)).toBe('not_found');
  });
  it('does the same for every rehearsal and leaves the others alone', async () => {
    const one = await create();
    const two = await create();
    const other = await create();
    for (const r of [one, two]) {
      await transitionApplication(db, r.id, { status: 'dry_run_ready', set: { answers: [answer('q', String(r.id))], mode: 'dry_run' } });
    }
    await transitionApplication(db, other.id, { status: 'failed' });
    expect(await sendAllRehearsals(db, [one.id, two.id, other.id])).toEqual({ queued: 2, skipped: 1 });
    expect((await applicationForJob(db, one.job.id))!.approvedAnswers).toEqual([answer('q', String(one.id))]);
    expect(await applicationForJob(db, two.job.id)).toMatchObject({ status: 'queued', mode: 'real' });
    expect(await applicationForJob(db, other.job.id)).toMatchObject({ status: 'failed', approvedAnswers: [] });
    expect(await sendAllRehearsals(db, [one.id, two.id])).toEqual({ queued: 0, skipped: 2 });
  });
});

describe('a job the owner already applied to', () => {
  const applied = [{ column: 'aplicada' }, { column: 'arquivada' }, { appliedBy: 'humano' }] as const;
  const answer = { questionId: 'q', value: 'x', source: 'bank' as const, category: 'profile_fact' as const, basis: [], bankAnswerId: null, label: 'q', help: '', kind: 'text' as const, options: [], required: true };

  it('is never retried', async () => {
    for (const extra of applied) {
      const { id, job } = await create();
      await transitionApplication(db, id, { status: 'cancelled' });
      await db.update(jobs).set(extra).where(eq(jobs.id, job.id));
      expect(await retryApplication(db, id)).toBe('already_applied');
      expect((await applicationForJob(db, job.id))!.status).toBe('cancelled');
    }
  });

  it('is never sent, alone or with the others', async () => {
    for (const extra of applied) {
      const { id, job } = await create();
      await transitionApplication(db, id, { status: 'dry_run_ready', set: { answers: [answer] } });
      await db.update(jobs).set(extra).where(eq(jobs.id, job.id));
      expect(await sendRehearsal(db, id)).toBe('already_applied');
      expect((await applicationForJob(db, job.id))!.status).toBe('dry_run_ready');
    }
  });

  it('settles a waiting application as applied by the owner, flags a running one and leaves the rest', async () => {
    const message = 'Você marcou esta vaga como aplicada.';
    const cases = [
      { status: 'queued', reason: null }, { status: 'needs_human', reason: 'question' },
      { status: 'needs_human', reason: 'confirm_submission' }, { status: 'dry_run_ready', reason: null },
    ] as const;
    for (const c of cases) {
      const { id, job } = await create();
      if (c.status !== 'queued') await transitionApplication(db, id, { status: c.status, reason: c.reason }, 2000);
      await db.update(jobs).set({ needsHuman: true, needsHumanReason: 'x' }).where(eq(jobs.id, job.id));
      expect(await settleAppliedByOwner(db, job.id, 3000)).toBe(true);
      expect(await applicationForJob(db, job.id)).toMatchObject({
        status: 'skipped', reason: 'already_applied', finishedAt: 3000, pendingQuestions: [], cancelRequested: false,
      });
      expect((await listApplicationEvents(db, id)).at(-1)).toEqual({ status: 'skipped', message, at: 3000 });
      expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0]).toMatchObject({ needsHuman: false });
      await db.update(jobs).set({ column: 'aplicada', appliedBy: 'humano' }).where(eq(jobs.id, job.id)); // o que a rota grava
      expect(await retryApplication(db, id)).toBe('already_applied');
    }
    const running = await create();
    await transitionApplication(db, running.id, { status: 'submitting' }, 2000);
    expect(await settleAppliedByOwner(db, running.job.id, 3000)).toBe(true);
    expect(await applicationForJob(db, running.job.id)).toMatchObject({ status: 'submitting', cancelRequested: true });
    const failed = await create();
    await transitionApplication(db, failed.id, { status: 'failed' }, 2000);
    expect(await settleAppliedByOwner(db, failed.job.id, 3000)).toBe(false);
    expect((await applicationForJob(db, failed.job.id))!.status).toBe('failed');
    expect(await settleAppliedByOwner(db, 123_456, 3000)).toBe(false);
  });

  it('locks the job row before the application', async () => {
    const { id, job } = await create();
    await db.transaction(async (tx) => {
      const locked = await lockApplicationWithJob(tx, id);
      expect(locked).toMatchObject({ row: { id }, job: { id: job.id } });
    });
    expect(await db.transaction((tx) => lockApplicationWithJob(tx, 999_999))).toBeNull();
  });
});

describe('answering pending questions', () => {
  const question = (id: string, required: boolean) => ({
    question: { id, label: id, help: '', kind: 'text' as const, options: [], required, maxLength: null },
    category: 'unknown' as const, kind: 'unanswered' as const, proposal: null,
  });
  it('requeues the other question waits only, with the mark off and their own mode kept', async () => {
    const asked = await create();
    const other = await create();
    const captcha = await create();
    await db.update(jobs).set({ needsHuman: true, needsHumanReason: 'x' });
    await transitionApplication(db, asked.id, { status: 'needs_human', reason: 'question' });
    await transitionApplication(db, other.id, { status: 'needs_human', reason: 'question', set: { mode: 'dry_run' } });
    await transitionApplication(db, captcha.id, { status: 'needs_human', reason: 'captcha' });
    expect(await requeueQuestionWaits(db, asked.id)).toEqual([other.id]);
    expect(await applicationForJob(db, other.job.id)).toMatchObject({ status: 'queued', mode: 'dry_run' });
    expect((await applicationForJob(db, asked.job.id))!.status).toBe('needs_human');
    expect((await applicationForJob(db, captcha.job.id))!.status).toBe('needs_human');
    expect((await db.select().from(jobs).where(eq(jobs.id, other.job.id)))[0]).toMatchObject({ needsHuman: false });
    expect((await db.select().from(jobs).where(eq(jobs.id, captcha.job.id)))[0]).toMatchObject({ needsHuman: true });
  });
  it('keeps the row in needs_human while a required question is left, and requeues when none is', async () => {
    const { id, job } = await create();
    await db.update(jobs).set({ needsHuman: true, needsHumanReason: 'x' }).where(eq(jobs.id, job.id));
    await transitionApplication(db, id, {
      status: 'needs_human', reason: 'question', set: { pendingQuestions: [question('a', true), question('b', false)] },
    });
    let row = (await applicationForJob(db, job.id))!;
    expect(await settlePendingQuestions(db, row, [question('a', true)])).toBe(false);
    row = (await applicationForJob(db, job.id))!;
    expect(row).toMatchObject({ status: 'needs_human', reason: 'question' });
    expect(row.pendingQuestions).toHaveLength(1);
    expect(await settlePendingQuestions(db, row, [question('b', false)])).toBe(true);
    expect(await applicationForJob(db, job.id)).toMatchObject({ status: 'queued', reason: null, pendingQuestions: [] });
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0]).toMatchObject({ needsHuman: false, needsHumanReason: null });
  });
});

describe('a stale cancel flag never follows a row back to the queue', () => {
  const flag = (id: number) => db.update(applications).set({ cancelRequested: true }).where(eq(applications.id, id));
  const answer = { questionId: 'q', value: 'x', source: 'bank' as const, category: 'profile_fact' as const, basis: [], bankAnswerId: null, label: 'q', help: '', kind: 'text' as const, options: [], required: true };

  it('clears cancel_requested in every helper that puts a row back to queued', async () => {
    const retried = await create();
    const rehearsal = await create();
    const allRehearsals = await create();
    const waiting = await create();
    const answered = await create();
    const asked = await create();
    await transitionApplication(db, retried.id, { status: 'failed' });
    await transitionApplication(db, rehearsal.id, { status: 'dry_run_ready', set: { answers: [answer] } });
    await transitionApplication(db, waiting.id, { status: 'needs_human', reason: 'question' });
    await transitionApplication(db, answered.id, { status: 'needs_human', reason: 'question' });
    await transitionApplication(db, asked.id, { status: 'needs_human', reason: 'captcha' });
    for (const r of [retried, rehearsal, allRehearsals, waiting, answered]) await flag(r.id);

    expect(await retryApplication(db, retried.id)).toBe('queued');
    expect(await sendRehearsal(db, rehearsal.id)).toBe('queued');
    await transitionApplication(db, allRehearsals.id, { status: 'dry_run_ready', set: { answers: [answer] } });
    expect(await sendAllRehearsals(db, [allRehearsals.id])).toEqual({ queued: 1, skipped: 0 });
    const answeredRow = (await applicationForJob(db, answered.job.id))!;
    expect(await settlePendingQuestions(db, answeredRow, [])).toBe(true);
    expect(await requeueQuestionWaits(db, asked.id)).toEqual([waiting.id]);

    for (const r of [retried, rehearsal, allRehearsals, waiting, answered]) {
      expect(await applicationForJob(db, r.job.id)).toMatchObject({ status: 'queued', cancelRequested: false });
    }
  });

  it('at recovery, honours the pending cancel of a row stopped before the click and never resends one past it', async () => {
    const cancelled = await create();
    const plain = await create();
    const clicked = await create();
    await transitionApplication(db, cancelled.id, { status: 'waiting_human', set: { waitingGate: 'captcha' } }, 2000);
    await transitionApplication(db, plain.id, { status: 'filling' }, 2000);
    await transitionApplication(db, clicked.id, { status: 'submitting', set: { waitingGate: 'captcha' } }, 2000);
    for (const r of [cancelled, clicked]) await flag(r.id);

    expect(await recoverApplications(db, 5000)).toEqual({ requeued: 1, unconfirmed: [clicked.id] });
    expect(await applicationForJob(db, cancelled.job.id)).toMatchObject({
      status: 'cancelled', cancelRequested: false, waitingGate: null, finishedAt: 5000,
    });
    expect((await listApplicationEvents(db, cancelled.id)).at(-1)).toMatchObject({ status: 'cancelled', at: 5000 });
    expect(await applicationForJob(db, plain.job.id)).toMatchObject({ status: 'queued', cancelRequested: false });
    expect(await applicationForJob(db, clicked.job.id)).toMatchObject({
      status: 'needs_human', reason: 'confirm_submission', cancelRequested: false, waitingGate: null,
    });
  });
});

// O PGlite aceita um número no lugar de um timestamp; o Postgres de verdade recusa ("date/time field value out of range").
// Então o teste confere o que seria enviado ao driver: todo valor de tempo dentro de um fragmento `sql` tem de passar pelo
// mapeamento da coluna (ISO 8601), nunca ir como número.
describe('time parameters in raw sql fragments', () => {
  it('sends ISO strings, not numbers, for the time parameters of applyCountsSince and nextQueuedApplication', async () => {
    const { drizzle } = await import('drizzle-orm/pglite');
    const { PGlite } = await import('@electric-sql/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const { MIGRATIONS_FOLDER } = await import('./migrate');
    const schema = await import('./schema');
    const seen: unknown[][] = [];
    const logged = drizzle(new PGlite(), { schema, logger: { logQuery: (_query, params) => void seen.push(params) } });
    try {
      await migrate(logged, { migrationsFolder: MIGRATIONS_FOLDER });
      seen.length = 0;
      await applyCountsSince(logged, 1_700_000_000_000);
      await nextQueuedApplication(logged, { excludeSites: [] }, 1_700_000_000_000);
      const iso = new Date(1_700_000_000_000).toISOString();
      expect(seen[0]).toEqual([iso, iso]);
      expect(seen[1]).toContain(iso);
      expect(seen.flat()).not.toContain(1_700_000_000_000);
    } finally {
      await closeDb(logged);
    }
  });
});
