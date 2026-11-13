import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { closeDb, jobEvents, jobs, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { NEEDS_HUMAN_REASONS } from '@kv/shared';
import { markAppliedByOwner, moveCardByAi, needsHumanText, setNeedsHuman } from './board';

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
