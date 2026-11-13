import { normalizeQuestionText, type Question } from '@kv/shared';
import type { ApplyAnswerRow } from '@kv/db';

export interface BankContext {
  company: string;
  jobId: number;
  /** País da vaga em ISO-2, quando se sabe. */
  country: string | null;
}

const SCOPE_RANK = { job: 0, company: 1, always: 2 } as const;

function inScope(row: ApplyAnswerRow, ctx: BankContext): boolean {
  if (row.scope === 'company') return normalizeQuestionText(row.scopeValue ?? '') === normalizeQuestionText(ctx.company);
  if (row.scope === 'job') return row.scopeValue === String(ctx.jobId);
  return true;
}

/** Respostas que valem para esta vaga: não vazias, com alcance e país compatíveis. */
export function bankCandidates(bank: ApplyAnswerRow[], ctx: BankContext): ApplyAnswerRow[] {
  return bank.filter(
    (row) =>
      row.answer.trim() !== '' && inScope(row, ctx) && (row.country === null || (ctx.country !== null && row.country === ctx.country)),
  );
}

/** A opção cujo texto normalizado é igual ao da resposta salva, ou null. Nunca traduz. */
export function optionFor(saved: string, options: string[]): string | null {
  const target = normalizeQuestionText(saved);
  if (target === '') return null;
  return options.find((o) => normalizeQuestionText(o) === target) ?? null;
}

function sameOptionSet(a: string[], b: string[]): boolean {
  const key = (xs: string[]) => JSON.stringify(xs.map(normalizeQuestionText).sort());
  return key(a) === key(b);
}

function valueFor(row: ApplyAnswerRow, question: Question): string | null {
  const normalized = normalizeQuestionText(question.label);
  const isList = question.options.length > 0;
  if (row.normalized === normalized) return isList ? optionFor(row.answer, question.options) : row.answer;
  const alias = row.aliases.find((x) => x.normalized === normalized && sameOptionSet(x.options, question.options));
  if (!alias) return null;
  if (isList) return optionFor(alias.value, question.options);
  return alias.value.trim() !== '' ? alias.value : row.answer;
}

/**
 * Casamento que vale sem confirmação: o texto normalizado da pergunta é igual ao da resposta salva, ou a uma variação
 * confirmada com o mesmo conjunto de opções. Em pergunta de lista, a resposta precisa ser uma das opções.
 * Entre várias, vence o alcance mais específico e, depois, a resposta do país da vaga.
 */
export function exactBankMatch(
  question: Question, bank: ApplyAnswerRow[], ctx: BankContext,
): { answer: ApplyAnswerRow; value: string } | null {
  const hits: { answer: ApplyAnswerRow; value: string }[] = [];
  for (const row of bankCandidates(bank, ctx)) {
    const value = valueFor(row, question);
    if (value !== null) hits.push({ answer: row, value });
  }
  if (hits.length === 0) return null;
  const countryRank = (r: ApplyAnswerRow) => (r.country !== null ? 0 : 1);
  hits.sort(
    (x, y) =>
      countryRank(x.answer) - countryRank(y.answer) ||
      SCOPE_RANK[x.answer.scope] - SCOPE_RANK[y.answer.scope] ||
      x.answer.id - y.answer.id,
  );
  return hits[0]!;
}
