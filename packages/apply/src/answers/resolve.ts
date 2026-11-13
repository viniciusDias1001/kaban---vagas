import {
  QUESTION_CATEGORIES, normalizeQuestionText, sameOptionSet, type AnswerRecord, type AnswerValue, type ApplyAiAnswers,
  type PendingQuestion, type Question, type QuestionCategory, type ResolvedAnswer,
} from '@kv/shared';
import type { ApplyAnswerRow } from '@kv/db';
import { bankCandidates, exactBankMatch, optionFor, type BankContext } from './bank';
import { answerByRule, classifyByRule, declineOption, hasLastNameField, isWorkedHereQuestion, type RuleContext } from './rules';

export interface ResolveDeps {
  classify(questions: Question[]): Promise<Map<string, QuestionCategory>>;
  proposeMatches(
    questions: Question[], candidates: ApplyAnswerRow[],
  ): Promise<Map<string, { bankAnswerId: number; option: string | null }>>;
  /** Só fatos que já passaram por `verifyProfileFact`. */
  profileFacts(questions: Question[]): Promise<Map<string, { value: AnswerValue; basis: string[] }>>;
  /** Null quando o verificador barra o texto depois da tentativa de correção. */
  writeOpen(question: Question): Promise<string | null>;
}

export interface ResolveInput {
  questions: Question[];
  bank: ApplyAnswerRow[];
  ctx: RuleContext & BankContext;
  /** Respostas propostas pelo modelo (fatos do perfil e textos escritos): nunca, com aprovação do dono, ou direto. */
  aiAnswers: ApplyAiAnswers;
  /**
   * As respostas de um ensaio que o dono viu e mandou enviar de verdade ("Enviar de verdade"). O worker passa esta
   * lista só nesse caminho, e uma lista vazia em todos os outros. É essa aprovação que permite repetir uma resposta
   * `profile` ou `written` em qualquer modo. Vale para a mesma pergunta: texto normalizado, ajuda, tipo e opções;
   * uma resposta `bank` só se repete se a resposta salva ainda existe e ainda dá o mesmo valor.
   */
  approved: AnswerRecord[];
}

export interface Resolution { answers: ResolvedAnswer[]; pending: PendingQuestion[]; usedBankIds: number[] }

/** Categorias que o modelo nunca responde: só regra (não informar) e banco. */
const OWNER_ONLY: ReadonlySet<QuestionCategory> = new Set(['personal', 'demographic']);

const answer = (
  q: Question, category: QuestionCategory, value: AnswerValue, source: ResolvedAnswer['source'],
  extra: { basis?: string[]; bankAnswerId?: number | null } = {},
): ResolvedAnswer => ({ questionId: q.id, value, source, category, basis: extra.basis ?? [], bankAnswerId: extra.bankAnswerId ?? null });

/** Mesmo valor pelo conteúdo: uma lista (multiselect) vale o mesmo que a outra com os mesmos itens, ou que o item sozinho. */
function sameValue(a: AnswerValue, b: AnswerValue): boolean {
  if (typeof a !== 'string' && !Array.isArray(a)) return a === b;
  if (typeof b !== 'string' && !Array.isArray(b)) return false;
  const items = (v: string | string[]) => JSON.stringify((Array.isArray(v) ? [...v] : [v]).sort());
  return items(a) === items(b);
}

/** A resposta aprovada é desta pergunta: mesmo texto e ajuda normalizados, mesmo tipo, mesmo conjunto de opções. */
export function matchesApproved(record: AnswerRecord, question: Question): boolean {
  return normalizeQuestionText(record.label) === normalizeQuestionText(question.label) &&
    normalizeQuestionText(record.help ?? '') === normalizeQuestionText(question.help) && record.kind === question.kind &&
    sameOptionSet(record.options, question.options);
}

/**
 * A resposta aprovada para a mesma pergunta, ajustada às opções de agora; null se a pergunta mudou ou se a resposta
 * salva de que ela veio foi apagada ou editada (aí a pergunta é resolvida de novo pelo banco atual).
 */
function approvedAnswer(q: Question, approved: AnswerRecord[], bank: ApplyAnswerRow[], ctx: BankContext): ResolvedAnswer | null {
  const prev = approved.find((p) => matchesApproved(p, q));
  if (!prev) return null;
  if (prev.source === 'blank' && q.required) return null;
  let value = prev.value;
  if (q.options.length > 0 && value !== null && typeof value !== 'boolean') {
    const mapped = (Array.isArray(value) ? value : [value]).map((v) => optionFor(v, q.options));
    if (mapped.some((v) => v === null)) return null;
    value = Array.isArray(value) ? (mapped as string[]) : mapped[0]!;
  }
  if (prev.source === 'bank') {
    const row = bank.find((r) => r.id === prev.bankAnswerId);
    const current = row ? exactBankMatch(q, [row], ctx) : null;
    if (!current || !sameValue(current.value, value)) return null;
  }
  return { questionId: q.id, value, source: prev.source, category: prev.category, basis: [...prev.basis], bankAnswerId: prev.bankAnswerId };
}

/**
 * Decide, pergunta a pergunta, quem pode responder. A ordem existe para que nada seja enviado em nome do dono sem
 * que ele tenha dado aquela resposta: `personal` e `demographic` só aceitam a opção de não informar e o banco;
 * o que o modelo propõe só vira resposta no modo `auto`; casamento proposto pelo modelo sempre volta ao dono.
 */
export async function resolveAnswers(input: ResolveInput, deps: ResolveDeps): Promise<Resolution> {
  const { questions, bank, aiAnswers, approved } = input;
  const ctx = { ...input.ctx, splitName: hasLastNameField(questions) };
  const answers = new Map<string, ResolvedAnswer>();
  const pending = new Map<string, PendingQuestion>();
  const category = new Map<string, QuestionCategory>();
  const bankHit = (q: Question, cat: QuestionCategory): boolean => {
    const hit = exactBankMatch(q, bank, ctx);
    if (hit) answers.set(q.id, answer(q, cat, hit.value, 'bank', { bankAnswerId: hit.answer.id }));
    return hit !== null;
  };

  // 1. Pergunta igual a uma do ensaio aprovado pelo dono: repete a resposta e a origem.
  const fresh: Question[] = [];
  for (const q of questions) {
    const repeated = approvedAnswer(q, approved, bank, ctx);
    if (repeated) answers.set(q.id, repeated);
    else fresh.push(q);
  }

  // 2. Categoria: as regras primeiro (os padrões sensíveis antes de tudo); o modelo só vê o que sobrou.
  const unclassified: Question[] = [];
  for (const q of fresh) {
    const byRule = classifyByRule(q, ctx.job.company);
    if (byRule) category.set(q.id, byRule);
    else unclassified.push(q);
  }
  if (unclassified.length > 0) {
    const byModel = await deps.classify(unclassified);
    for (const q of unclassified) {
      const c = byModel.get(q.id);
      category.set(q.id, c && (QUESTION_CATEGORIES as readonly string[]).includes(c) ? c : 'unknown');
    }
  }

  // 3 a 7. Regra e banco; o que precisa do modelo fica separado.
  const askModel = aiAnswers !== 'off';
  const facts: Question[] = [];
  const opens: Question[] = [];
  /** Sem resposta, vão direto ao dono: nem resposta salva, nem proposta de casamento. */
  const ownerDirect = new Set<string>();
  for (const q of fresh) {
    let cat = category.get(q.id)!;
    // "Já trabalhou na empresa desta vaga?": só a regra (um "não" seguro); se ela não souber, o dono.
    if (!OWNER_ONLY.has(cat) && isWorkedHereQuestion(q, ctx)) {
      cat = 'profile_fact';
      category.set(q.id, cat);
      const value = answerByRule(q, cat, ctx);
      if (value !== undefined) answers.set(q.id, answer(q, cat, value, 'rule'));
      else ownerDirect.add(q.id);
      continue;
    }
    if (cat === 'file') ownerDirect.add(q.id);
    switch (cat) {
      case 'identity': case 'file': case 'origin': case 'consent': {
        const value = answerByRule(q, cat, ctx);
        if (value !== undefined) answers.set(q.id, answer(q, cat, value, 'rule'));
        else if (cat !== 'file') bankHit(q, cat);
        break;
      }
      case 'demographic': {
        if (!q.required) {
          answers.set(q.id, answer(q, cat, null, 'blank'));
          break;
        }
        const decline = declineOption(q.options);
        if (decline !== null) answers.set(q.id, answer(q, cat, decline, 'rule'));
        else bankHit(q, cat);
        break;
      }
      case 'personal': case 'unknown':
        bankHit(q, cat);
        break;
      case 'profile_fact': {
        const value = answerByRule(q, cat, ctx);
        if (value !== undefined) answers.set(q.id, answer(q, cat, value, 'rule'));
        else if (bankHit(q, cat)) break;
        // Em `review`, campo opcional nunca para a candidatura: fica em branco e o modelo não é chamado.
        else if (!q.required && aiAnswers === 'review') answers.set(q.id, answer(q, cat, null, 'blank'));
        else if (askModel) facts.push(q);
        break;
      }
      case 'open':
        // Texto escrito pelo modelo só em campo obrigatório; o opcional sem resposta salva fica em branco.
        if (bankHit(q, cat)) break;
        if (!q.required) answers.set(q.id, answer(q, cat, null, 'blank'));
        else if (askModel) opens.push(q);
        break;
    }
  }

  /** Proposta do modelo: resposta só em `auto`; em `review`, pendência para o dono aprovar. */
  const proposal = (q: Question, value: AnswerValue, source: 'profile' | 'written', basis: string[]) => {
    const cat = category.get(q.id)!;
    if (OWNER_ONLY.has(cat)) return; // não acontece pela ordem acima; fica como trava
    if (aiAnswers === 'auto') answers.set(q.id, answer(q, cat, value, source, { basis }));
    else if (q.required) {
      pending.set(q.id, {
        question: q, category: cat, kind: 'confirm_proposal',
        proposal: { bankAnswerId: null, bankQuestion: null, bankAnswer: null, value, source, basis: [...basis] },
      });
    }
  };
  if (facts.length > 0) {
    const found = await deps.profileFacts(facts);
    for (const q of facts) {
      const fact = found.get(q.id);
      if (fact && fact.value !== null && fact.value !== '') proposal(q, fact.value, 'profile', fact.basis);
    }
  }
  for (const q of opens) {
    const text = await deps.writeOpen(q);
    if (text !== null && text.trim() !== '') proposal(q, text, 'written', []);
  }

  // 8. Sem resposta: uma resposta salva que o modelo diz servir volta ao dono para confirmar.
  const open = (): Question[] => fresh.filter((q) => !answers.has(q.id) && !pending.has(q.id));
  const candidates = bankCandidates(bank, ctx);
  const left = open().filter((q) => !ownerDirect.has(q.id));
  if (left.length > 0 && candidates.length > 0) {
    const proposals = await deps.proposeMatches(left, candidates);
    for (const q of left) {
      const p = proposals.get(q.id);
      const row = p && candidates.find((r) => r.id === p.bankAnswerId);
      if (!p || !row) continue;
      const value = q.options.length > 0 ? optionFor(p.option ?? row.answer, q.options) : row.answer;
      if (value === null) continue;
      pending.set(q.id, {
        question: q, category: category.get(q.id)!, kind: 'confirm_match',
        proposal: { bankAnswerId: row.id, bankQuestion: row.question, bankAnswer: row.answer, value, source: 'bank', basis: [] },
      });
    }
  }

  // 9. Ainda sem resposta: obrigatória vira pendência; opcional fica em branco.
  for (const q of open()) {
    const cat = category.get(q.id)!;
    if (q.required) pending.set(q.id, { question: q, category: cat, kind: 'unanswered', proposal: null });
    else answers.set(q.id, answer(q, cat, null, 'blank'));
  }

  const inOrder = <T>(map: Map<string, T>) => questions.flatMap((q) => (map.has(q.id) ? [map.get(q.id)!] : []));
  const resolved = inOrder(answers);
  return {
    answers: resolved,
    pending: inOrder(pending),
    usedBankIds: [...new Set(resolved.flatMap((x) => (x.bankAnswerId !== null ? [x.bankAnswerId] : [])))],
  };
}
