import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { applications, closeDb, createApplication, jobEvents, jobs, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { NEEDS_HUMAN_REASONS, type SkipReason } from '@kv/shared';
import { discardSkipped, discardSkippedCards, markAppliedByOwner, moveCardByAi, needsHumanText, setNeedsHuman } from './board';

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function seedJob(over: Partial<typeof jobs.$inferInsert> = {}) {
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: String(Math.random()), url: `https://example.com/${Math.random()}`, title: 'Dev React',
      company: 'Acme Fictícia', location: 'SP', country: 'BR', remote: true, stacks: [], description: 'd',
      postedAt: null, discoveredAt: 1, dedupHash: String(Math.random()), profileId: null, position: 0, ...over,
    })
    .returning();
  return row.id;
}
const jobRow = async (id: number) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];
const lastEvent = async (id: number) => (await db.select().from(jobEvents).where(eq(jobEvents.jobId, id)).orderBy(asc(jobEvents.id))).at(-1);

describe('moveCardByAi', () => {
  it('moves the card to the top with an event by the AI', async () => {
    const other = await seedJob({ column: 'aplicada', position: 5 });
    const id = await seedJob();
    await moveCardByAi(db, id, 'aplicada', 9000);
    expect(await jobRow(id)).toMatchObject({ column: 'aplicada', appliedBy: 'ia' });
    expect((await jobRow(id)).position).toBeLessThan((await jobRow(other)).position);
    expect(await lastEvent(id)).toMatchObject({ fromColumn: 'descobertas', toColumn: 'aplicada', actor: 'ia', createdAt: 9000 });
  });

  it('moving to selecionadas does not set applied_by', async () => {
    const id = await seedJob();
    await moveCardByAi(db, id, 'selecionadas', 9000);
    expect(await jobRow(id)).toMatchObject({ column: 'selecionadas', appliedBy: null });
  });

  it('does not pull a card back from a later column', async () => {
    const id = await seedJob({ column: 'entrevista' });
    await moveCardByAi(db, id, 'aplicada', 9000);
    await moveCardByAi(db, id, 'selecionadas', 9000);
    expect(await jobRow(id)).toMatchObject({ column: 'entrevista', appliedBy: null });
    expect(await db.select().from(jobEvents).where(eq(jobEvents.jobId, id))).toHaveLength(0);
  });

  it('takes a card out of Descartada (an application the owner asked again went through)', async () => {
    const id = await seedJob({ column: 'descartada' });
    await moveCardByAi(db, id, 'selecionadas', 9000);
    expect(await jobRow(id)).toMatchObject({ column: 'selecionadas' });
    await moveCardByAi(db, id, 'aplicada', 9100);
    expect(await jobRow(id)).toMatchObject({ column: 'aplicada', appliedBy: 'ia' });
  });

  it('does not move a card that is already in the target column', async () => {
    const id = await seedJob({ column: 'aplicada', position: 3 });
    await moveCardByAi(db, id, 'aplicada', 9000);
    expect(await jobRow(id)).toMatchObject({ column: 'aplicada', position: 3 });
  });
});

describe('markAppliedByOwner', () => {
  it('moves the card to aplicada as applied by the owner, with a system event', async () => {
    const id = await seedJob({ column: 'selecionadas' });
    await markAppliedByOwner(db, id, 9000);
    expect(await jobRow(id)).toMatchObject({ column: 'aplicada', appliedBy: 'humano' });
    expect(await lastEvent(id)).toMatchObject({ fromColumn: 'selecionadas', toColumn: 'aplicada', actor: 'sistema' });
  });
});

/** Uma candidatura já pulada pelo motivo dado, para a vaga. */
async function skippedApplication(jobId: number, reason: SkipReason) {
  const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'auto', mode: 'real' }, 1000))!;
  await db.update(applications).set({ status: 'skipped', reason }).where(eq(applications.id, id));
}

describe('discardSkipped (a skip that sets the card aside)', () => {
  it('moves the card from Descobertas or Selecionadas to the top of Descartada with an event by the AI, for each of the three reasons', async () => {
    for (const reason of ['below_min_score', 'not_eligible', 'closed'] as const) {
      for (const from of ['descobertas', 'selecionadas'] as const) {
        const other = await seedJob({ column: 'descartada', position: 4 });
        const id = await seedJob({ column: from, position: 9 });
        expect(await discardSkipped(db, id, reason, 9000), `${reason} ${from}`).toBe(true);
        expect(await jobRow(id)).toMatchObject({ column: 'descartada', appliedBy: null });
        expect((await jobRow(id)).position).toBeLessThan((await jobRow(other)).position);
        expect(await lastEvent(id)).toMatchObject({ fromColumn: from, toColumn: 'descartada', actor: 'ia', createdAt: 9000 });
      }
    }
  });

  it('leaves the card where it is for the other skip reasons', async () => {
    for (const reason of ['blocked', 'external', 'already_applied'] as const) {
      const id = await seedJob();
      expect(await discardSkipped(db, id, reason, 9000), reason).toBe(false);
      expect(await jobRow(id)).toMatchObject({ column: 'descobertas' });
      expect(await db.select().from(jobEvents).where(eq(jobEvents.jobId, id))).toHaveLength(0);
    }
  });

  it('never touches a card the owner already moved to another column', async () => {
    for (const column of ['aplicada', 'entrevista', 'oferta', 'perdida', 'descartada', 'arquivada'] as const) {
      const id = await seedJob({ column, position: 3 });
      expect(await discardSkipped(db, id, 'closed', 9000), column).toBe(false);
      expect(await jobRow(id)).toMatchObject({ column, position: 3 });
      expect(await db.select().from(jobEvents).where(eq(jobEvents.jobId, id))).toHaveLength(0);
    }
  });
});

describe('discardSkippedCards (the catch-up for skips recorded before Descartada existed)', () => {
  it('moves cards in Descobertas with an application skipped for one of the three reasons, once', async () => {
    const low = await seedJob();
    const ineligible = await seedJob();
    const closed = await seedJob();
    for (const [id, reason] of [[low, 'below_min_score'], [ineligible, 'not_eligible'], [closed, 'closed']] as const) {
      await skippedApplication(id, reason);
    }
    const blocked = await seedJob();
    await skippedApplication(blocked, 'blocked');
    const selected = await seedJob({ column: 'selecionadas' });
    await skippedApplication(selected, 'below_min_score');
    const untouched = await seedJob();

    expect(await discardSkippedCards(db, 9000)).toBe(3);
    for (const id of [low, ineligible, closed]) {
      expect(await jobRow(id)).toMatchObject({ column: 'descartada' });
      expect(await lastEvent(id)).toMatchObject({ fromColumn: 'descobertas', toColumn: 'descartada', actor: 'ia' });
    }
    expect(await jobRow(blocked)).toMatchObject({ column: 'descobertas' });
    expect(await jobRow(selected)).toMatchObject({ column: 'selecionadas' });
    expect(await jobRow(untouched)).toMatchObject({ column: 'descobertas' });
    // Idempotente: a próxima varredura não acha nada.
    expect(await discardSkippedCards(db, 9500)).toBe(0);
    expect(await db.select().from(jobEvents).where(eq(jobEvents.jobId, low))).toHaveLength(1);
  });

  it('does not take back a card the owner dragged out of Descartada into Descobertas', async () => {
    const id = await seedJob();
    await skippedApplication(id, 'closed');
    expect(await discardSkippedCards(db, 9000)).toBe(1);
    await db.update(jobs).set({ column: 'descobertas' }).where(eq(jobs.id, id));
    await db.insert(jobEvents).values({ jobId: id, fromColumn: 'descartada', toColumn: 'descobertas', actor: 'humano', createdAt: 9100 });
    expect(await discardSkippedCards(db, 9200)).toBe(0);
    expect(await jobRow(id)).toMatchObject({ column: 'descobertas' });
  });
});

describe('setNeedsHuman and needsHumanText', () => {
  it('sets and clears the flag', async () => {
    const id = await seedJob();
    await setNeedsHuman(db, id, 'Falta uma resposta.');
    expect(await jobRow(id)).toMatchObject({ needsHuman: true, needsHumanReason: 'Falta uma resposta.' });
    await setNeedsHuman(db, id, null);
    expect(await jobRow(id)).toMatchObject({ needsHuman: false, needsHumanReason: null });
  });

  it('has a fixed pt-BR sentence for each reason, with the detail when there is one', () => {
    for (const reason of NEEDS_HUMAN_REASONS) expect(needsHumanText(reason, null)).toMatch(/\S/);
    expect(needsHumanText('question', 'Qual seu salário?')).toContain('Qual seu salário?');
    expect(needsHumanText('captcha', null)).not.toContain('null');
  });
});
