import {
  AiError, answerProfileFacts, classifyQuestions, dayStartMs, proposeBankMatches, verifyOpenAnswer, verifyProfileFact, writeOpenAnswer,
  type AiConfig, type AiProvider, type AiTier, type JobForAi, type TaskResult,
} from '@kv/ai';
import type { ResolveDeps } from '@kv/apply';
import { aiSpentSince, type Db } from '@kv/db';
import type { AnswerValue, CandidateProfile, ResumeLang } from '@kv/shared';
import { createBilling, type Billing } from '../ai/billing';

/**
 * O limite diário de gasto com IA foi atingido antes de uma chamada da candidatura. Lançado de dentro de `resolve`, o
 * motor descarta o formulário e o relança (é um erro que ele não conhece); a fila o reconhece e devolve a candidatura à
 * fila para o dia seguinte, sem contar tentativa.
 */
export class ApplyBudgetError extends Error {
  constructor() {
    super('limite diário de IA atingido');
    this.name = 'ApplyBudgetError';
  }
}

export interface ApplyAi {
  /** Há IA configurada (provedor e chave)? Sem ela, `ai()` lança `AiError('config')`; qualquer outro erro sobe. */
  configured(): Promise<boolean>;
  /** O gasto de hoje (no fuso do orçamento) ainda está abaixo do limite diário? */
  mayCall(): Promise<boolean>;
  /** Pergunta `mayCall` e faz a chamada cobrada na camada `apply`. Sem orçamento: `ApplyBudgetError`, sem chamada. */
  call<T>(tier: AiTier, fn: (provider: AiProvider) => Promise<TaskResult<T>>): Promise<TaskResult<T>>;
  /** Para `applicationResume`: a cobrança com a camada trocada por `apply` (ela pergunta `mayCall` sozinha). */
  billing(): Promise<Billing>;
  /** O fuso em que o dia do orçamento é contado: a espera pelo próximo dia de orçamento vai até a meia-noite dele. */
  budgetTimeZone(): Promise<string>;
}

/**
 * A IA de UMA candidatura. O provedor e a configuração (com a chave decifrada) são lidos na primeira chamada e
 * descartados com a candidatura; sem IA configurada, a primeira chamada lança o `AiError('config')` de `ai()`.
 */
export function createApplyAi(deps: {
  db: Db; ai: () => Promise<{ provider: AiProvider; config: AiConfig }>; now: () => number; log: (msg: string) => void;
}): ApplyAi {
  const { db, now, log } = deps;
  let loaded: Promise<{ billing: Billing; config: AiConfig }> | null = null;
  const load = () =>
    (loaded ??= deps.ai().then(({ provider, config }) => ({ billing: createBilling({ db, now, log }, provider, config), config })));

  async function mayCall(): Promise<boolean> {
    const { config } = await load();
    return (await aiSpentSince(db, dayStartMs(now(), config.budgetTimeZone))) < config.dailyBudgetUsd;
  }

  return {
    async configured() {
      try {
        await load();
        return true;
      } catch (e) {
        if (e instanceof AiError && e.kind === 'config') return false;
        throw e;
      }
    },
    mayCall,
    async call(tier, fn) {
      if (!(await mayCall())) throw new ApplyBudgetError();
      const { billing } = await load();
      return billing.billed('apply', tier, () => fn(billing.provider));
    },
    async billing() {
      const { billing } = await load();
      return { provider: billing.provider, billed: (_layer, tier, call) => billing.billed('apply', tier, call) };
    },
    async budgetTimeZone() {
      return (await load()).config.budgetTimeZone;
    },
  };
}

/**
 * As chamadas ao modelo de que `resolveAnswers` precisa, todas cobradas em `apply` e cada uma depois de `mayCall`.
 * `profileFacts` só devolve fatos que passaram por `verifyProfileFact`; `writeOpen` só devolve texto que passou por
 * `verifyOpenAnswer`, com UMA tentativa de correção que leva as violações da primeira; senão null. Sem IA configurada,
 * nenhuma chama o modelo e todas devolvem "nada" (sem classificação, sem proposta, sem fato, sem texto): as regras e o
 * banco de respostas continuam valendo e o resto vai ao dono.
 */
export function resolveDepsFor(
  ai: ApplyAi,
  input: { profile: CandidateProfile; job: JobForAi; lang: ResumeLang; signal: AbortSignal; now: () => number },
): ResolveDeps {
  const { profile, job, lang, signal, now } = input;
  return {
    async classify(questions) {
      if (!(await ai.configured())) return new Map();
      return (await ai.call('fast', (p) => classifyQuestions(p, questions, { signal }))).data;
    },
    async proposeMatches(questions, candidates) {
      if (!(await ai.configured())) return new Map();
      const offered = candidates.map((c) => ({ id: c.id, question: c.question, answer: c.answer }));
      return (await ai.call('fast', (p) => proposeBankMatches(p, questions, offered, { signal }))).data;
    },
    async profileFacts(questions) {
      if (!(await ai.configured())) return new Map();
      const found = (await ai.call('fast', (p) => answerProfileFacts(p, profile, questions, { signal }))).data;
      const out = new Map<string, { value: AnswerValue; basis: string[] }>();
      for (const q of questions) {
        const fact = found.get(q.id);
        if (!fact) continue;
        const checked = verifyProfileFact(profile, q, fact, now());
        if (checked.ok) out.set(q.id, { value: checked.value, basis: fact.basis });
      }
      return out;
    },
    async writeOpen(question) {
      if (!(await ai.configured())) return null;
      const write = async (violations?: ReturnType<typeof verifyOpenAnswer>) =>
        (await ai.call('strong', (p) => writeOpenAnswer(p, { profile, job, question, lang, violations }, { signal }))).data;
      let text = await write();
      let violations = verifyOpenAnswer(profile, job, question, text, now());
      if (violations.length === 0) return text;
      text = await write(violations);
      violations = verifyOpenAnswer(profile, job, question, text, now());
      return violations.length === 0 ? text : null;
    },
  };
}
