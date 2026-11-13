import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applications, closeDb, createApplication, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { APPLY_DEFAULTS, type ApplyConfig } from '@kv/shared';
import { sweepCandidates } from './sweep';
import { HOUR, NOON, createRecordingSite, seedJob, seedProfile } from './test-helpers';

const cfg = (over: Partial<ApplyConfig> = {}): ApplyConfig => ({
  enabled: true, minScore: 70, siteModes: { linkedin: 'dry_run', greenhouse: 'dry_run', lever: 'dry_run', fake: 'dry_run' },
  dailyCaps: { ...APPLY_DEFAULTS.dailyCaps }, companyCap: 2, window: { start: '08:00', end: '21:00' }, resumeMode: 'tailored',
  aiAnswers: 'review', blockedCompanies: [], blockedTerms: [], timeZone: 'America/Sao_Paulo', ...over,
});
const site = createRecordingSite();

let db: Db;
let version: number;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  version = await seedProfile(db);
});
afterAll(() => closeDb(db));

/** Uma candidatura que já abriu o formulário em `at`. */
async function opened(at: number) {
  const job = await seedJob(db, { score: null });
  const id = (await createApplication(db, { jobId: job.id, site: 'fake', trigger: 'auto', mode: 'real' }, at))!;
  await db.update(applications).set({ status: 'submitted', formOpenedAt: at }).where(eq(applications.id, id));
}

describe('sweepCandidates', () => {
  it('queues only what fits today', async () => {
    for (let i = 0; i < 20; i++) await seedJob(db, { version });
    for (let i = 0; i < 3; i++) await opened(NOON - HOUR);
    expect(await sweepCandidates(db, cfg(), [site], NOON)).toBe(12);
    // A fila já ocupa o resto do dia: a próxima varredura não cria mais nada.
    expect(await sweepCandidates(db, cfg(), [site], NOON + 60_000)).toBe(0);
  });

  it('stops at the total cap', async () => {
    for (let i = 0; i < 10; i++) await seedJob(db, { version });
    for (let i = 0; i < 3; i++) await opened(NOON - HOUR);
    expect(await sweepCandidates(db, cfg({ dailyCaps: { ...APPLY_DEFAULTS.dailyCaps, total: 5 } }), [site], NOON)).toBe(2);
  });

  it('does not count yesterday', async () => {
    for (let i = 0; i < 20; i++) await seedJob(db, { version });
    // 23:59 de ontem em São Paulo
    for (let i = 0; i < 15; i++) await opened(Date.UTC(2026, 10, 11, 2, 59));
    expect(await sweepCandidates(db, cfg(), [site], Date.UTC(2026, 10, 11, 11, 0))).toBe(15);
  });

  it('uses the mode configured for the site', async () => {
    const job = await seedJob(db, { version });
    expect(await sweepCandidates(db, cfg({ siteModes: { ...cfg().siteModes, fake: 'real' } }), [site], NOON)).toBe(1);
    const [row] = await db.select().from(applications).where(eq(applications.jobId, job.id));
    expect(row).toMatchObject({ status: 'queued', trigger: 'auto', mode: 'real', site: 'fake' });
  });

  it('ignores jobs no site accepts', async () => {
    await seedJob(db, { version, source: 'remotive' });
    expect(await sweepCandidates(db, cfg(), [site], NOON)).toBe(0);
    expect(await db.select().from(applications)).toEqual([]);
  });

  it('ignores jobs below the minimum score or too old', async () => {
    await seedJob(db, { version, score: 69 });
    await seedJob(db, { version, discoveredAt: NOON - 15 * 86_400_000 });
    expect(await sweepCandidates(db, cfg(), [site], NOON)).toBe(0);
  });
});
