import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { CandidateProfile } from '@kv/shared';
import {
  aiSpentSince, aiTasks, baseProfile, candidateProfiles, closeDb, confirmAiTask, enqueueAiTask, jobAi, jobs,
  latestAiTasks, jobSubject, profileFor, recordUsage, resumes, saveProfile, usageByLayer, type Db,
} from './index';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

const profile: CandidateProfile = {
  contact: { name: 'Maria Exemplo da Silva', email: 'maria@exemplo.test', phone: '', location: 'São Paulo, SP' },
  summary: 'Pessoa fictícia.', experiences: [], education: [], skills: [{ id: 'skill_aaaaaaaa', name: 'React' }],
  languages: [], certifications: [], links: [],
};

async function seedJob(url = 'https://example.com/1') {
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: url, url, title: 'Dev', company: 'ACME', location: 'Remoto', country: 'BR',
      remote: true, level: null, stacks: [], description: '', postedAt: null, discoveredAt: 1, dedupHash: url,
      profileId: null, position: 1,
    })
    .returning();
  return row;
}

const rowsOf = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
  ((await db.execute(query)) as unknown as { rows: T[] }).rows;

describe('ai tables', () => {
  it('have row level security enabled, like every other table', async () => {
    const rows = await rowsOf<{ relname: string; relrowsecurity: boolean }>(
      sql`select relname, relrowsecurity from pg_class
          where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([
      'ai_keys', 'ai_tasks', 'ai_usage', 'job_ai', 'job_events', 'jobs', 'profiles', 'resumes', 'runs', 'search_profiles',
      'settings', 'tailored_resumes',
    ]);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('store the resume binary and return it byte for byte', async () => {
    const content = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
    await db.insert(resumes).values({
      lang: 'pt-BR', fileName: 'cv.pdf', mime: 'application/pdf', content, extractedText: 'texto', uploadedAt: 1,
    });
    const [row] = await db.select().from(resumes);
    expect(Buffer.isBuffer(row.content)).toBe(true);
    expect(row.content.equals(content)).toBe(true);
  });

  // Gravar 5 MiB no PGlite é lento com a máquina ocupada: este teste tem tempo limite próprio.
  it('refuse a resume above 5 MiB and a second resume for the same language', async () => {
    const values = { lang: 'en' as const, fileName: 'cv.pdf', mime: 'application/pdf', extractedText: 't', uploadedAt: 1 };
    await expect(db.insert(resumes).values({ ...values, content: Buffer.alloc(5 * 1024 * 1024 + 1) })).rejects.toThrow();
    await db.insert(resumes).values({ ...values, content: Buffer.alloc(8) });
    await expect(db.insert(resumes).values({ ...values, content: Buffer.alloc(8) })).rejects.toThrow();
  }, 60_000);

  it('delete the ai rows of a job together with the job', async () => {
    const job = await seedJob();
    await db.insert(jobAi).values({ jobId: job.id, score: 80 });
    await enqueueAiTask(db, { type: 'tier2', jobId: job.id });
    await db.delete(jobs).where(eq(jobs.id, job.id));
    expect(await db.select().from(jobAi)).toHaveLength(0);
    expect(await db.select().from(aiTasks)).toHaveLength(0);
  });

  it('add description_fetched_at to jobs, empty by default', async () => {
    expect((await seedJob()).descriptionFetchedAt).toBeNull();
  });
});

describe('enqueueAiTask', () => {
  it('queues one pending task per type and target, and a new one after the first finishes', async () => {
    const job = await seedJob();
    const first = await enqueueAiTask(db, { type: 'tier1', jobId: job.id }, 10);
    expect(first).toBeTypeOf('number');
    expect(await enqueueAiTask(db, { type: 'tier1', jobId: job.id })).toBeNull();
    expect(await enqueueAiTask(db, { type: 'tier2', jobId: job.id })).toBeTypeOf('number');
    expect(await enqueueAiTask(db, { type: 'profile_extract', lang: 'en' })).toBeTypeOf('number');
    expect(await enqueueAiTask(db, { type: 'profile_extract', lang: 'en' })).toBeNull();
    expect(await enqueueAiTask(db, { type: 'profile_extract', lang: 'pt-BR' })).toBeTypeOf('number');

    for (const status of ['running', 'blocked_budget'] as const) {
      await db.update(aiTasks).set({ status }).where(eq(aiTasks.id, first!));
      expect(await enqueueAiTask(db, { type: 'tier1', jobId: job.id })).toBeNull();
    }
    await db.update(aiTasks).set({ status: 'error' }).where(eq(aiTasks.id, first!));
    const again = await enqueueAiTask(db, { type: 'tier1', jobId: job.id });
    expect(again).toBeGreaterThan(first!);

    const latest = await latestAiTasks(db, jobSubject(job.id), ['tier1', 'tier2', 'tier3']);
    expect(latest.get('tier1')?.id).toBe(again);
    expect(latest.get('tier2')?.status).toBe('queued');
    expect(latest.has('tier3')).toBe(false);
  });

  it('confirmAiTask releases only a budget-blocked task', async () => {
    const job = await seedJob();
    const id = (await enqueueAiTask(db, { type: 'tier3', jobId: job.id }))!;
    expect(await confirmAiTask(db, id)).toBe(false);
    await db.update(aiTasks).set({ status: 'blocked_budget' }).where(eq(aiTasks.id, id));
    expect(await confirmAiTask(db, id)).toBe(true);
    const [task] = await db.select().from(aiTasks).where(eq(aiTasks.id, id));
    expect(task).toMatchObject({ status: 'queued', confirmed: true });
    expect(await confirmAiTask(db, 999)).toBe(false);
  });
});

describe('profiles', () => {
  it('saveProfile gives every write the next global version and replaces the row of the language', async () => {
    expect(await baseProfile(db)).toBeNull();
    expect((await saveProfile(db, 'en', profile, 'extraido', 5)).version).toBe(1);
    expect((await baseProfile(db))?.lang).toBe('en');
    expect((await saveProfile(db, 'pt-BR', profile, 'traduzido', 6)).version).toBe(2);
    expect((await baseProfile(db))?.lang).toBe('pt-BR');
    const edited = await saveProfile(db, 'en', { ...profile, summary: 'Edited' }, 'editado', 7);
    expect(edited).toMatchObject({ version: 3, origin: 'editado', updatedAt: 7 });
    expect(await db.select().from(candidateProfiles)).toHaveLength(2);
    expect((await profileFor(db, 'en'))?.data.summary).toBe('Edited');
  });
});

describe('usage', () => {
  it('sums the estimated cost since a moment, in total and per layer', async () => {
    const base = { provider: 'fake', model: 'fake-fast', inputTokens: 10, outputTokens: 5 };
    await recordUsage(db, { ...base, layer: 'tier1', costUsd: 0.25, createdAt: 100 });
    await recordUsage(db, { ...base, layer: 'tier1', costUsd: 0.5, createdAt: 200 });
    await recordUsage(db, { ...base, layer: 'tier3', costUsd: 1, createdAt: 300 });
    expect(await aiSpentSince(db, 0)).toBeCloseTo(1.75);
    expect(await aiSpentSince(db, 200)).toBeCloseTo(1.5);
    expect(await aiSpentSince(db, 301)).toBe(0);
    expect(await usageByLayer(db, 200)).toEqual({ profile: 0, tier1: 0.5, tier2: 0, tier3: 1, test: 0 });
  });
});
