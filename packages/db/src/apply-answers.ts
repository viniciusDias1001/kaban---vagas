import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { AnswerScope, ApplyAnswerDto } from '@kv/shared';
import { normalizeQuestionText } from '@kv/shared';
import type { Db } from './client';
import { applyAnswers } from './schema';

export type ApplyAnswerRow = typeof applyAnswers.$inferSelect;
type Alias = ApplyAnswerRow['aliases'][number];

/** As perguntas comuns, criadas vazias. `country` nulo = qualquer outro país. */
export const SEED_ANSWERS: readonly { key: string; question: string; kind: ApplyAnswerRow['kind']; country: string | null }[] = [
  { key: 'salary_brl_month', question: 'Pretensão salarial (R$ por mês)', kind: 'number', country: null },
  { key: 'salary_usd_year', question: 'Salary expectation (USD per year)', kind: 'number', country: null },
  { key: 'work_authorization', question: 'Você tem autorização para trabalhar no Brasil?', kind: 'boolean', country: 'BR' },
  { key: 'visa_sponsorship', question: 'Você precisa de patrocínio de visto?', kind: 'boolean', country: null },
  { key: 'start_availability', question: 'Quando você pode começar?', kind: 'text', country: null },
  { key: 'relocation', question: 'Você aceita se mudar de cidade?', kind: 'boolean', country: null },
  { key: 'work_models', question: 'Quais modelos de trabalho você aceita?', kind: 'text', country: null },
  { key: 'pronouns', question: 'Pronomes', kind: 'text', country: null },
];

/** Insere só as chaves que faltam (por chave e país); os índices únicos são só rede de segurança. */
export async function ensureSeedAnswers(db: Db, now: number = Date.now()): Promise<void> {
  const existing = await db
    .select({ key: applyAnswers.key, country: applyAnswers.country })
    .from(applyAnswers);
  const has = new Set(existing.filter((r) => r.key !== null).map((r) => `${r.key}|${r.country ?? ''}`));
  const missing = SEED_ANSWERS.filter((s) => !has.has(`${s.key}|${s.country ?? ''}`));
  if (missing.length === 0) return;
  await db
    .insert(applyAnswers)
    .values(
      missing.map((s) => ({
        key: s.key, question: s.question, normalized: normalizeQuestionText(s.question), kind: s.kind, country: s.country,
        createdAt: now, updatedAt: now,
      })),
    )
    .onConflictDoNothing();
}

export async function listApplyAnswers(db: Db): Promise<ApplyAnswerRow[]> {
  return db.select().from(applyAnswers).orderBy(asc(applyAnswers.id));
}

export async function saveApplyAnswer(
  db: Db,
  input: {
    id?: number; question: string; answer: string; kind: ApplyAnswerRow['kind'];
    scope: AnswerScope; scopeValue: string | null; country: string | null;
  },
  now: number = Date.now(),
): Promise<ApplyAnswerRow> {
  const fields = {
    question: input.question.trim(),
    normalized: normalizeQuestionText(input.question),
    answer: input.answer,
    kind: input.kind,
    scope: input.scope,
    scopeValue: input.scope === 'always' ? null : input.scopeValue,
    country: input.country,
    updatedAt: now,
  };
  if (input.id !== undefined) {
    const [row] = await db.update(applyAnswers).set(fields).where(eq(applyAnswers.id, input.id)).returning();
    if (!row) throw new Error(`Resposta ${input.id} não existe.`);
    return row;
  }
  const [row] = await db.insert(applyAnswers).values({ ...fields, createdAt: now }).returning();
  return row!;
}

const sameOptions = (a: string[], b: string[]): boolean => {
  const key = (xs: string[]) => JSON.stringify(xs.map(normalizeQuestionText).sort());
  return key(a) === key(b);
};

/** O dono confirmou que este texto (com este conjunto de opções) pede a mesma coisa. Repetir substitui a variação anterior. */
export async function confirmAlias(db: Db, id: number, alias: Alias, now: number = Date.now()): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(applyAnswers).where(eq(applyAnswers.id, id)).for('update');
    if (!row) return;
    const kept = row.aliases.filter((x) => !(x.normalized === alias.normalized && sameOptions(x.options, alias.options)));
    await tx.update(applyAnswers).set({ aliases: [...kept, alias], updatedAt: now }).where(eq(applyAnswers.id, id));
  });
}

export async function removeAlias(db: Db, id: number, normalized: string, now: number = Date.now()): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(applyAnswers).where(eq(applyAnswers.id, id)).for('update');
    if (!row) return;
    await tx
      .update(applyAnswers)
      .set({ aliases: row.aliases.filter((x) => x.normalized !== normalized), updatedAt: now })
      .where(eq(applyAnswers.id, id));
  });
}

export async function deleteApplyAnswer(db: Db, id: number): Promise<boolean> {
  const rows = await db.delete(applyAnswers).where(eq(applyAnswers.id, id)).returning({ id: applyAnswers.id });
  return rows.length > 0;
}

/** Soma 1 ao uso de cada resposta da lista (id repetido na lista conta uma vez). */
export async function markAnswersUsed(db: Db, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(applyAnswers)
    .set({ usedCount: sql`${applyAnswers.usedCount} + 1` })
    .where(inArray(applyAnswers.id, [...new Set(ids)]));
}

export function toApplyAnswerDto(row: ApplyAnswerRow): ApplyAnswerDto {
  return {
    id: row.id, question: row.question, key: row.key, answer: row.answer, kind: row.kind, scope: row.scope,
    scopeValue: row.scopeValue, country: row.country, aliases: row.aliases, usedCount: row.usedCount, updatedAt: row.updatedAt,
  };
}
