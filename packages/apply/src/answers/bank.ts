import { bankBoolean, bankList, normalizeQuestionText, optionKey, sameOptionSet, type Question } from '@kv/shared';
import type { ApplyAnswerRow } from '@kv/db';

export interface BankContext {
  company: string;
  jobId: number;
  /** País da vaga em ISO-2, quando se sabe. */
  country: string | null;
}

const SCOPE_RANK = { job: 0, company: 1, always: 2 } as const;

function inScope(row: ApplyAnswerRow, ctx: BankContext): boolean {
  if (row.scope === 'company') {
    const wanted = normalizeQuestionText(row.scopeValue ?? '');
    return wanted !== '' && wanted === normalizeQuestionText(ctx.company);
  }
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

/** A única opção com a mesma chave estrita da resposta salva (símbolos e dígitos contam), ou null. Nunca traduz. */
export function optionFor(saved: string, options: string[]): string | null {
  const target = optionKey(saved);
  if (target === '') return null;
  const hits = options.filter((o) => optionKey(o) === target);
  return hits.length === 1 ? hits[0]! : null;
}

export type BankValue = string | string[] | boolean;

/** O texto salvo lido como o valor do tipo da pergunta (ver `bankText` em @kv/shared); null se não serve. */
function readSaved(text: string, question: Question): BankValue | null {
  if (question.kind === 'multiselect') {
    const lines = bankList(text);
    const picked = lines.map((line) => optionFor(line, question.options));
    if (lines.length === 0 || picked.some((o) => o === null)) return null;
    return [...new Set(picked as string[])];
  }
  if (question.options.length > 0) return optionFor(text, question.options);
  if (question.kind === 'boolean') return bankBoolean(text);
  return text;
}

/**
 * O valor de uma proposta de casamento (a resposta salva `saved` que o modelo disse servir para `question`), no tipo
 * da pergunta, lido como `exactBankMatch` o leria; null se a resposta salva não serve. Múltipla escolha: as linhas
 * salvas, todas casando com as opções; senão, só a opção que o modelo apontou (`option`), numa lista de um item.
 * Lista de uma escolha: a opção apontada pelo modelo, ou a resposta salva. Caixa sem opções: sim ou não.
 */
export function proposedValue(saved: string, question: Question, option: string | null): BankValue | null {
  if (question.kind === 'multiselect') {
    const all = readSaved(saved, question);
    if (all !== null) return all;
    const one = option !== null ? optionFor(option, question.options) : null;
    return one !== null ? [one] : null;
  }
  if (question.options.length > 0) return optionFor(option ?? saved, question.options);
  return readSaved(saved, question);
}

function valueFor(row: ApplyAnswerRow, question: Question): BankValue | null {
  const normalized = normalizeQuestionText(question.label);
  if (normalized === '') return null;
  if (row.normalized === normalized) return readSaved(row.answer, question);
  const alias = row.aliases.find((x) => x.normalized === normalized && sameOptionSet(x.options, question.options));
  if (!alias) return null;
  // A variação guarda o valor no mesmo formato; pergunta de texto livre segue usando a resposta salva.
  const typedQuestion = question.options.length > 0 || question.kind === 'boolean' || question.kind === 'multiselect';
  return readSaved(typedQuestion ? alias.value : row.answer, question);
}

/**
 * Casamento que vale sem confirmação: o texto normalizado da pergunta é igual ao da resposta salva, ou a uma variação
 * confirmada com o mesmo conjunto de opções. Em pergunta de lista, a resposta precisa ser uma das opções.
 * Entre várias, vence o alcance mais específico (job, company, always); no mesmo alcance, a resposta do país da vaga; depois o menor id.
 */
export function exactBankMatch(
  question: Question, bank: ApplyAnswerRow[], ctx: BankContext,
): { answer: ApplyAnswerRow; value: BankValue } | null {
  const hits: { answer: ApplyAnswerRow; value: BankValue }[] = [];
  for (const row of bankCandidates(bank, ctx)) {
    const value = valueFor(row, question);
    if (value !== null) hits.push({ answer: row, value });
  }
  if (hits.length === 0) return null;
  const countryRank = (r: ApplyAnswerRow) => (r.country !== null ? 0 : 1);
  hits.sort(
    (x, y) =>
      SCOPE_RANK[x.answer.scope] - SCOPE_RANK[y.answer.scope] ||
      countryRank(x.answer) - countryRank(y.answer) ||
      x.answer.id - y.answer.id,
  );
  return hits[0]!;
}
