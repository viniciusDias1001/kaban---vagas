import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from './index';
import {
  SEED_ANSWERS, confirmAlias, deleteApplyAnswer, ensureSeedAnswers, listApplyAnswers, markAnswersUsed, removeAlias,
  saveApplyAnswer, toApplyAnswerDto,
} from './apply-answers';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

const base = { kind: 'text' as const, scope: 'always' as const, scopeValue: null, country: null };

describe('answer bank (db)', () => {
  it('seeds the common questions once, empty', async () => {
    await ensureSeedAnswers(db);
    await ensureSeedAnswers(db);
    const rows = await listApplyAnswers(db);
    expect(rows.map((r) => r.key)).toEqual(SEED_ANSWERS.map((s) => s.key));
    expect(rows.every((r) => r.answer === '')).toBe(true);
  });

  it('only inserts the seed keys that are missing', async () => {
    await ensureSeedAnswers(db);
    const [first] = await listApplyAnswers(db);
    await saveApplyAnswer(db, { ...base, id: first!.id, question: first!.question, answer: '10000' });
    await ensureSeedAnswers(db);
    const rows = await listApplyAnswers(db);
    expect(rows).toHaveLength(SEED_ANSWERS.length);
    expect(rows[0]!.answer).toBe('10000');
  });

  it('stores the normalized text and keeps confirmed variations', async () => {
    const saved = await saveApplyAnswer(db, { ...base, question: 'Qual a sua Pretensão Salarial?', answer: 'R$ 20.000' }, 5);
    expect(saved.normalized).toBe('qual a sua pretensao salarial');
    expect(saved.key).toBeNull();
    const edited = await saveApplyAnswer(
      db,
      { ...base, id: saved.id, question: 'Pretensão?', answer: 'R$ 21.000', scope: 'company', scopeValue: 'Acme' },
      9,
    );
    expect(edited).toMatchObject({
      id: saved.id, normalized: 'pretensao', answer: 'R$ 21.000', scope: 'company', scopeValue: 'Acme', createdAt: 5, updatedAt: 9,
    });

    const alias = { normalized: 'salary expectation', options: ['Yes', 'No'], value: 'No' };
    await confirmAlias(db, saved.id, alias, 10);
    await confirmAlias(db, saved.id, { ...alias, value: 'Yes' }, 11);
    await confirmAlias(db, saved.id, { normalized: 'other', options: [], value: 'x' }, 12);
    let [row] = await listApplyAnswers(db);
    expect(row!.aliases).toEqual([{ ...alias, value: 'Yes' }, { normalized: 'other', options: [], value: 'x' }]);
    expect(toApplyAnswerDto(row!).aliases).toHaveLength(2);

    await removeAlias(db, saved.id, 'salary expectation', 13);
    [row] = await listApplyAnswers(db);
    expect(row!.aliases).toEqual([{ normalized: 'other', options: [], value: 'x' }]);
    expect(row!.updatedAt).toBe(13);
  });

  it('counts uses and deletes', async () => {
    const a = await saveApplyAnswer(db, { ...base, question: 'A', answer: '1' });
    const b = await saveApplyAnswer(db, { ...base, question: 'B', answer: '2' });
    await markAnswersUsed(db, [a.id, a.id, b.id]);
    await markAnswersUsed(db, []);
    const rows = await listApplyAnswers(db);
    expect(rows.map((r) => r.usedCount)).toEqual([1, 1]);
    expect(await deleteApplyAnswer(db, a.id)).toBe(true);
    expect(await deleteApplyAnswer(db, a.id)).toBe(false);
  });
});
