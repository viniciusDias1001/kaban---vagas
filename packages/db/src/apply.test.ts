import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ApplySiteId, CandidateProfile } from '@kv/shared';
import { closeDb, type Db } from './index';
import {
  listApplicationEvents, applicationForJob, applyCandidates, applyCountsSince, companyFormsSince, createApplication,
  deleteApplyData, enqueueApplyCommand, finishApplyCommand, listApplications, nextApplyCommand, nextQueuedApplication,
  recoverApplications, requestCancel, siteState, toApplicationDto, transitionApplication, updateSiteState,
} from './apply';
import { deleteAllAiData } from './ai';
import { applications, applyAnswers, applyCommands, candidateProfiles, jobAi, jobs } from './schema';
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
    expect(await applicationForJob(db, failed.job.id)).toMatchObject({ startedAt: 4000, finishedAt: 4000, detail: 'x' });
  });

  it('applies the set fields and clears reason and detail when omitted', async () => {
    const { job, id } = await create();
    await transitionApplication(db, id, { status: 'needs_human', reason: 'question', detail: 'd', set: { waitingGate: 'captcha', attempts: 2 } }, 2000);
    expect(await applicationForJob(db, job.id)).toMatchObject({ reason: 'question', detail: 'd', waitingGate: 'captcha', attempts: 2 });
    await transitionApplication(db, id, { status: 'queued' }, 2100);
    expect(await applicationForJob(db, job.id)).toMatchObject({ reason: null, detail: null, waitingGate: 'captcha' });
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
    expect(dto).toMatchObject({ id: b.id, hasResume: true, resumeFileName: 'cv.pdf' });
    expect(JSON.stringify(dto)).not.toContain('resumePdf');
    expect(dto.events).toHaveLength(2);
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

  it('cancels a queued application at once and flags a running one', async () => {
    const queued = await create();
    const running = await create();
    const submitted = await create();
    await transitionApplication(db, running.id, { status: 'filling' }, 2000);
    await transitionApplication(db, submitted.id, { status: 'submitted' }, 2000);
    expect(await requestCancel(db, queued.job.id, 3000)).toBe(true);
    expect(await applicationForJob(db, queued.job.id)).toMatchObject({ status: 'cancelled', finishedAt: 3000 });
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

  it('returns null when there is no command', async () => {
    expect(await nextApplyCommand(db)).toBeNull();
  });

  it('creates the site row with defaults and patches it', async () => {
    expect(await siteState(db, 'lever')).toMatchObject({ site: 'lever', session: 'unknown', paused: false, consecutiveFailures: 0 });
    await updateSiteState(db, 'lever', { paused: true, pauseReason: 'brake', consecutiveFailures: 3 });
    expect(await siteState(db, 'lever')).toMatchObject({ paused: true, pauseReason: 'brake', consecutiveFailures: 3 });
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
          label: 'L', kind: 'text', options: [], required: true,
        }],
      },
    }, 2000);
    await db.insert(applyAnswers).values({ question: 'q', normalized: 'q', kind: 'text', createdAt: 1, updatedAt: 1 });
    await deleteApplyData(db);
    expect(await applicationForJob(db, job.id)).toMatchObject({
      status: 'submitted', submittedAt: 2000, answers: [], pendingQuestions: [], resumePdf: null, contactEmail: null,
      confirmation: null, shots: {},
    });
    expect(await db.select().from(applyAnswers)).toEqual([]);
  });

  it('runs with deleteAllAiData', async () => {
    const { job } = await create();
    await db.update(applications).set({ contactEmail: 'a@example.com' }).where(eq(applications.jobId, job.id));
    await deleteAllAiData(db);
    expect((await applicationForJob(db, job.id))!.contactEmail).toBeNull();
  });
});
