import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeQuestionText, type AnswerRecord, type CandidateProfile, type Question, type QuestionCategory } from '@kv/shared';
import type { ApplyAnswerRow } from '@kv/db';
import { resolveAnswers, type ResolveDeps, type ResolveInput } from './resolve';

const q = (id: string, label: string, required = true, extra: Partial<Question> = {}): Question => ({
  id, label, help: '', kind: 'text', options: [], required, maxLength: null, ...extra,
});
const select = (id: string, label: string, options: string[], required = true): Question =>
  q(id, label, required, { kind: 'select', options });
let seq = 100;
const a = (over: Partial<ApplyAnswerRow> & { question: string; answer: string }): ApplyAnswerRow => ({
  id: ++seq, normalized: normalizeQuestionText(over.question), key: null, kind: 'text', scope: 'always',
  scopeValue: null, country: null, aliases: [], usedCount: 0, createdAt: 0, updatedAt: 0, ...over,
});

const profile: CandidateProfile = {
  contact: { name: 'Maria Exemplo', email: 'maria@exemplo.com', phone: '', location: 'São Paulo, SP, Brasil' },
  summary: '', experiences: [], education: [], skills: [], languages: [], certifications: [],
  links: [{ id: 'lnk_aaaaaaa1', label: 'LinkedIn', url: 'https://www.linkedin.com/in/maria-exemplo' }],
};
const ctx: ResolveInput['ctx'] = {
  profile,
  job: { id: 1, source: 'linkedin', url: 'https://example.test/vaga/1', externalId: '1', company: 'Acme', title: 'Dev' },
  sourceLabel: 'LinkedIn', resumeFileName: 'Maria_Exemplo_CV.pdf', company: 'Acme', jobId: 1, country: 'BR',
};
const input = (questions: Question[], bank: ApplyAnswerRow[] = [], over: Partial<ResolveInput> = {}): ResolveInput => ({
  questions, bank, ctx, aiAnswers: 'review', previous: [], ...over,
});

const deps = {
  classify: vi.fn<ResolveDeps['classify']>(),
  proposeMatches: vi.fn<ResolveDeps['proposeMatches']>(),
  profileFacts: vi.fn<ResolveDeps['profileFacts']>(),
  writeOpen: vi.fn<ResolveDeps['writeOpen']>(),
};
/** The model classifies each question it is asked about as given here; anything else stays `unknown`. */
const modelSays = (categories: Record<string, QuestionCategory>) =>
  deps.classify.mockImplementation(async (qs) => new Map(qs.filter((x) => categories[x.id]).map((x) => [x.id, categories[x.id]!])));
const idsOf = (calls: Question[][]) => calls.flat().map((x) => x.id);

beforeEach(() => {
  vi.resetAllMocks();
  deps.classify.mockResolvedValue(new Map());
  deps.proposeMatches.mockResolvedValue(new Map());
  deps.profileFacts.mockResolvedValue(new Map());
  deps.writeOpen.mockResolvedValue(null);
});

describe('questions the model must never answer', () => {
  it('never sends a personal answer proposed by the model without confirmation', async () => {
    const bank = [a({ id: 7, question: 'Precisa de patrocínio de visto?', answer: 'Não' })];
    deps.proposeMatches.mockResolvedValue(new Map([['q1', { bankAnswerId: 7, option: 'No' }]]));
    const res = await resolveAnswers(input([select('q1', 'Are you legally authorized to work in the US?', ['Yes', 'No'], true)], bank), deps);
    expect(res.answers).toEqual([]);
    expect(res.pending).toEqual([expect.objectContaining({ kind: 'confirm_match', category: 'personal',
      proposal: { bankAnswerId: 7, bankQuestion: 'Precisa de patrocínio de visto?', value: 'No', source: 'bank', basis: [] } })]);
    expect(res.usedBankIds).toEqual([]);
  });

  it('does not ask the model to classify a question the sensitive patterns already caught', async () => {
    await resolveAnswers(input([q('q1', 'Pretensão salarial', true)]), deps);
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it('never calls profileFacts or writeOpen for personal and demographic questions, in any mode', async () => {
    for (const aiAnswers of ['off', 'review', 'auto'] as const) {
      modelSays({ q3: 'personal', q4: 'demographic' });
      const questions = [
        q('q1', 'Valor', true, { help: 'Informe sua pretensão salarial' }),
        select('q2', 'Status', ['I will require visa sponsorship', 'I will not'], true),
        q('q3', 'Quanto você ganha hoje?', true),
        q('q4', 'Como você se identifica?', true),
        q('q5', 'Gênero', true),
      ];
      const res = await resolveAnswers(input(questions, [], { aiAnswers }), deps);
      expect(deps.profileFacts).not.toHaveBeenCalled();
      expect(deps.writeOpen).not.toHaveBeenCalled();
      expect(idsOf(deps.classify.mock.calls.map((c) => c[0]))).toEqual(['q3', 'q4']);
      expect(res.answers).toEqual([]);
      expect(res.pending.map((p) => [p.question.id, p.category, p.kind])).toEqual([
        ['q1', 'personal', 'unanswered'], ['q2', 'personal', 'unanswered'], ['q3', 'personal', 'unanswered'],
        ['q4', 'demographic', 'unanswered'], ['q5', 'demographic', 'unanswered'],
      ]);
      vi.resetAllMocks();
      deps.classify.mockResolvedValue(new Map());
      deps.proposeMatches.mockResolvedValue(new Map());
    }
  });

  it('ignores the model category for a question the sensitive patterns caught', async () => {
    deps.classify.mockResolvedValue(new Map([['q1', 'open']]));
    deps.writeOpen.mockResolvedValue('R$ 50.000');
    const res = await resolveAnswers(input([q('q1', 'Conte sobre você', true, { help: 'Inclua sua pretensão salarial' })], [], { aiAnswers: 'auto' }), deps);
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.writeOpen).not.toHaveBeenCalled();
    expect(res.pending).toEqual([expect.objectContaining({ category: 'personal', kind: 'unanswered', proposal: null })]);
  });

  it('answers a personal question only with the exact saved answer', async () => {
    const bank = [a({ id: 9, question: 'Pretensão salarial (R$ por mês)', answer: '15000' })];
    const res = await resolveAnswers(input([q('q1', 'Pretensão salarial (R$ por mês)')], bank), deps);
    expect(res.answers).toEqual([{ questionId: 'q1', value: '15000', source: 'bank', category: 'personal', basis: [], bankAnswerId: 9 }]);
    expect(deps.proposeMatches).not.toHaveBeenCalled();
  });

  it('does not answer a question the model calls consent or identity unless a rule recognizes it', async () => {
    modelSays({ q1: 'consent', q2: 'identity', q3: 'origin' });
    const res = await resolveAnswers(input([
      q('q1', 'I certify that all information I gave is true', true, { kind: 'boolean' }),
      q('q2', 'Name of the person who referred you', true),
      q('q3', 'Who referred you?', true),
    ]), deps);
    expect(res.answers).toEqual([]);
    expect(res.pending.map((p) => [p.question.id, p.kind])).toEqual([['q1', 'unanswered'], ['q2', 'unanswered'], ['q3', 'unanswered']]);
  });
});

describe('answers proposed by the model', () => {
  const fact = q('q1', 'Quantos anos de experiência com React?');
  const open = q('q2', 'Por que você quer trabalhar aqui?');
  beforeEach(() => {
    modelSays({ q1: 'profile_fact', q2: 'open' });
    deps.profileFacts.mockResolvedValue(new Map([['q1', { value: '5', basis: ['exp_aaaaaaa1'] }]]));
    deps.writeOpen.mockResolvedValue('Porque gosto do produto.');
  });

  it('in review mode, sends nothing the model proposes and asks the owner instead', async () => {
    const res = await resolveAnswers(input([fact, open], [], { aiAnswers: 'review' }), deps);
    expect(res.answers).toEqual([]);
    expect(res.pending).toEqual([
      { question: fact, category: 'profile_fact', kind: 'confirm_proposal',
        proposal: { bankAnswerId: null, bankQuestion: null, value: '5', source: 'profile', basis: ['exp_aaaaaaa1'] } },
      { question: open, category: 'open', kind: 'confirm_proposal',
        proposal: { bankAnswerId: null, bankQuestion: null, value: 'Porque gosto do produto.', source: 'written', basis: [] } },
    ]);
  });

  it('in review mode, an optional question with a proposal also waits for the owner', async () => {
    const res = await resolveAnswers(input([{ ...open, required: false }]), deps);
    expect(res.answers).toEqual([]);
    expect(res.pending).toEqual([expect.objectContaining({ kind: 'confirm_proposal' })]);
  });

  it('in auto mode, uses the verified proposals as answers', async () => {
    const res = await resolveAnswers(input([fact, open], [], { aiAnswers: 'auto' }), deps);
    expect(res.pending).toEqual([]);
    expect(res.answers).toEqual([
      { questionId: 'q1', value: '5', source: 'profile', category: 'profile_fact', basis: ['exp_aaaaaaa1'], bankAnswerId: null },
      { questionId: 'q2', value: 'Porque gosto do produto.', source: 'written', category: 'open', basis: [], bankAnswerId: null },
    ]);
  });

  it('when off, never asks the model for an answer; required questions wait for the owner', async () => {
    const res = await resolveAnswers(input([fact, open], [], { aiAnswers: 'off' }), deps);
    expect(deps.profileFacts).not.toHaveBeenCalled();
    expect(deps.writeOpen).not.toHaveBeenCalled();
    expect(res.answers).toEqual([]);
    expect(res.pending.map((p) => [p.question.id, p.kind])).toEqual([['q1', 'unanswered'], ['q2', 'unanswered']]);
  });

  it('skips open answers when the switch is off', async () => {
    const res = await resolveAnswers(input([open], [], { aiAnswers: 'off' }), deps);
    expect(deps.writeOpen).not.toHaveBeenCalled();
    expect(res.pending).toEqual([expect.objectContaining({ question: open, kind: 'unanswered' })]);
  });

  it('uses the saved answer before asking the model', async () => {
    const bank = [a({ id: 3, question: 'Quantos anos de experiência com React?', answer: '4' }),
      a({ id: 4, question: 'Por que você quer trabalhar aqui?', answer: 'Texto salvo.' })];
    const res = await resolveAnswers(input([fact, open], bank, { aiAnswers: 'auto' }), deps);
    expect(deps.profileFacts).not.toHaveBeenCalled();
    expect(deps.writeOpen).not.toHaveBeenCalled();
    expect(res.answers.map((x) => [x.questionId, x.value, x.source])).toEqual([['q1', '4', 'bank'], ['q2', 'Texto salvo.', 'bank']]);
  });

  it('a written answer the verifier refused leaves a required question to the owner', async () => {
    deps.writeOpen.mockResolvedValue(null);
    const res = await resolveAnswers(input([open], [], { aiAnswers: 'auto' }), deps);
    expect(deps.writeOpen).toHaveBeenCalledWith(open);
    expect(res.pending).toEqual([expect.objectContaining({ question: open, kind: 'unanswered', proposal: null })]);
  });

  it('asks for profile facts only about profile facts', async () => {
    modelSays({ q1: 'profile_fact', q2: 'open', q3: 'unknown' });
    await resolveAnswers(input([fact, open, q('q3', 'Algo estranho')], [], { aiAnswers: 'auto' }), deps);
    expect(idsOf(deps.profileFacts.mock.calls.map((c) => c[0]))).toEqual(['q1']);
    expect(deps.writeOpen.mock.calls.map((c) => c[0].id)).toEqual(['q2']);
  });
});

describe('resolution order', () => {
  it('answers contact, résumé, source and consent by rule without the model', async () => {
    const res = await resolveAnswers(input([
      q('q1', 'E-mail'), q('q2', 'Resume/CV', true, { kind: 'file' }), q('q3', 'Como soube da vaga?'),
      q('q4', 'I agree to the privacy policy', true, { kind: 'boolean' }),
    ]), deps);
    expect(deps.classify).not.toHaveBeenCalled();
    expect(res.pending).toEqual([]);
    expect(res.answers.map((x) => [x.questionId, x.value, x.source, x.category])).toEqual([
      ['q1', 'maria@exemplo.com', 'rule', 'identity'], ['q2', 'Maria_Exemplo_CV.pdf', 'rule', 'file'],
      ['q3', 'LinkedIn', 'rule', 'origin'], ['q4', true, 'rule', 'consent'],
    ]);
  });

  it('answers whether the owner worked at the company by rule, even in off mode', async () => {
    modelSays({ q1: 'profile_fact' });
    const res = await resolveAnswers(input([select('q1', 'Have you previously worked at Acme?', ['Yes', 'No'])], [], { aiAnswers: 'off' }), deps);
    expect(res.answers).toEqual([{ questionId: 'q1', value: 'No', source: 'rule', category: 'profile_fact', basis: [], bankAnswerId: null }]);
    expect(deps.profileFacts).not.toHaveBeenCalled();
  });

  it('leaves optional questions blank and makes required ones pending', async () => {
    const res = await resolveAnswers(input([q('q1', 'Algo que ninguém sabe', false), q('q2', 'Outra coisa', true)]), deps);
    expect(res.answers).toEqual([expect.objectContaining({ questionId: 'q1', source: 'blank', value: null })]);
    expect(res.pending.map((p) => [p.question.id, p.kind])).toEqual([['q2', 'unanswered']]);
  });

  it('uses the decline option for a required demographic question', async () => {
    const res = await resolveAnswers(input([select('q1', 'Gênero', ['Feminino', 'Masculino', 'Prefiro não informar'])]), deps);
    expect(res.answers).toEqual([{ questionId: 'q1', value: 'Prefiro não informar', source: 'rule', category: 'demographic', basis: [], bankAnswerId: null }]);
  });

  it('leaves an optional demographic question blank even when a saved answer exists', async () => {
    const bank = [a({ id: 5, question: 'Gênero', answer: 'Feminino' })];
    const res = await resolveAnswers(input([select('q1', 'Gênero', ['Feminino', 'Masculino'], false)], bank), deps);
    expect(res.answers).toEqual([expect.objectContaining({ questionId: 'q1', source: 'blank', value: null, category: 'demographic' })]);
    expect(deps.proposeMatches).not.toHaveBeenCalled();
  });

  it('a required demographic question with no decline option uses the saved answer', async () => {
    const bank = [a({ id: 5, question: 'Gênero', answer: 'Feminino' })];
    const res = await resolveAnswers(input([select('q1', 'Gênero', ['Feminino', 'Masculino'])], bank), deps);
    expect(res.answers).toEqual([expect.objectContaining({ questionId: 'q1', value: 'Feminino', source: 'bank', bankAnswerId: 5 })]);
  });

  it('repeats the rehearsal answers verbatim', async () => {
    const previous: AnswerRecord[] = [{
      questionId: 'old-id', label: 'Why do you want to work here?', kind: 'text', options: [], required: true,
      value: 'Texto aprovado.', source: 'written', category: 'open', basis: [], bankAnswerId: null,
    }];
    const res = await resolveAnswers(input([q('q1', 'Why do you want to work here?'), q('q2', 'Outra coisa')], [], { previous }), deps);
    expect(res.answers).toEqual([{ questionId: 'q1', value: 'Texto aprovado.', source: 'written', category: 'open', basis: [], bankAnswerId: null }]);
    for (const spy of [deps.classify, deps.proposeMatches, deps.profileFacts]) expect(idsOf(spy.mock.calls.map((c) => c[0]))).not.toContain('q1');
    expect(deps.writeOpen.mock.calls.map((c) => c[0].id)).not.toContain('q1');
  });

  it('does not repeat a rehearsal answer when the options or the kind changed', async () => {
    const previous: AnswerRecord[] = [{
      questionId: 'q1', label: 'Nível de inglês', kind: 'select', options: ['Básico', 'Fluente'], required: true,
      value: 'Fluente', source: 'bank', category: 'unknown', basis: [], bankAnswerId: 2,
    }];
    const res = await resolveAnswers(input([select('q1', 'Nível de inglês', ['Básico', 'Intermediário', 'Fluente'])], [], { previous }), deps);
    expect(res.answers).toEqual([]);
    expect(deps.classify).toHaveBeenCalled();
  });

  it('lists the bank answers it used', async () => {
    const bank = [a({ id: 11, question: 'Pretensão salarial', answer: '15000' }), a({ id: 12, question: 'Pronomes', answer: 'ela/dela' }),
      a({ id: 13, question: 'Nunca usada', answer: 'x' })];
    const previous: AnswerRecord[] = [{
      questionId: 'q9', label: 'Notice period', kind: 'text', options: [], required: true,
      value: '30 dias', source: 'bank', category: 'personal', basis: [], bankAnswerId: 14,
    }];
    const res = await resolveAnswers(input([q('q1', 'Pretensão salarial'), q('q2', 'Pronomes'), q('q3', 'Notice period')], bank, { previous }), deps);
    expect(res.usedBankIds.sort()).toEqual([11, 12, 14]);
  });
});

describe('saved answers the model says fit', () => {
  it('offers only in-scope saved answers and only for the questions still without an answer', async () => {
    const inScope = a({ id: 21, question: 'Seu nível de inglês', answer: 'Fluente' });
    const otherCompany = a({ id: 22, question: 'Por que a Outra?', answer: 'x', scope: 'company', scopeValue: 'Outra' });
    await resolveAnswers(input([q('q1', 'E-mail'), q('q2', 'English level')], [inScope, otherCompany]), deps);
    expect(deps.proposeMatches).toHaveBeenCalledTimes(1);
    const [questions, candidates] = deps.proposeMatches.mock.calls[0]!;
    expect(questions.map((x) => x.id)).toEqual(['q2']);
    expect(candidates.map((x) => x.id)).toEqual([21]);
  });

  it('turns a proposal into a pending question for any category, never an answer', async () => {
    modelSays({ q1: 'profile_fact' });
    const bank = [a({ id: 21, question: 'Seu nível de inglês', answer: 'Fluente' })];
    deps.proposeMatches.mockResolvedValue(new Map([['q1', { bankAnswerId: 21, option: null }]]));
    const res = await resolveAnswers(input([q('q1', 'English level', false)], bank, { aiAnswers: 'auto' }), deps);
    expect(res.answers).toEqual([]);
    expect(res.pending).toEqual([{ question: q('q1', 'English level', false), category: 'profile_fact', kind: 'confirm_match',
      proposal: { bankAnswerId: 21, bankQuestion: 'Seu nível de inglês', value: 'Fluente', source: 'bank', basis: [] } }]);
  });

  it('drops a proposal for an answer that was not offered or an option that does not exist', async () => {
    const bank = [a({ id: 21, question: 'Seu nível de inglês', answer: 'Fluente' }),
      a({ id: 22, question: 'Outra empresa', answer: 'x', scope: 'company', scopeValue: 'Outra' })];
    deps.proposeMatches.mockResolvedValue(new Map([
      ['q1', { bankAnswerId: 22, option: null }],
      ['q2', { bankAnswerId: 21, option: 'Advanced' }],
      ['q3', { bankAnswerId: 21, option: null }],
    ]));
    const res = await resolveAnswers(input([q('q1', 'Algo'), select('q2', 'English', ['Basic', 'Fluent']),
      select('q3', 'Inglês', ['Básico', 'Fluente'])], bank), deps);
    expect(res.pending.map((p) => [p.question.id, p.kind, p.proposal?.value ?? null])).toEqual([
      ['q1', 'unanswered', null], ['q2', 'unanswered', null], ['q3', 'confirm_match', 'Fluente'],
    ]);
  });

  it('does not call proposeMatches when nothing is left or no saved answer applies', async () => {
    await resolveAnswers(input([q('q1', 'Algo')]), deps);
    await resolveAnswers(input([q('q1', 'E-mail')], [a({ question: 'x', answer: 'y' })]), deps);
    expect(deps.proposeMatches).not.toHaveBeenCalled();
  });
});
