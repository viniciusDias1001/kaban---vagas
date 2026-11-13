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
  questions, bank, ctx, aiAnswers: 'review', approved: [], ...over,
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
      proposal: { bankAnswerId: 7, bankQuestion: 'Precisa de patrocínio de visto?', bankAnswer: 'Não', value: 'No', source: 'bank', basis: [] } })]);
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
        q('q3', 'Algo sobre você que só você sabe', true),
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
      q('q1', 'I commit to the on-call rotation', true, { kind: 'boolean' }),
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
        proposal: { bankAnswerId: null, bankQuestion: null, bankAnswer: null, value: '5', source: 'profile', basis: ['exp_aaaaaaa1'] } },
      { question: open, category: 'open', kind: 'confirm_proposal',
        proposal: { bankAnswerId: null, bankQuestion: null, bankAnswer: null, value: 'Porque gosto do produto.', source: 'written', basis: [] } },
    ]);
  });

  it('in review mode, an optional profile fact is left blank and the model is not asked; in auto it is answered', async () => {
    const optional = { ...fact, required: false };
    const review = await resolveAnswers(input([optional], [], { aiAnswers: 'review' }), deps);
    expect(deps.profileFacts).not.toHaveBeenCalled();
    expect(review.pending).toEqual([]);
    expect(review.answers).toEqual([expect.objectContaining({ questionId: 'q1', source: 'blank', value: null })]);
    const auto = await resolveAnswers(input([optional], [], { aiAnswers: 'auto' }), deps);
    expect(auto.answers).toEqual([expect.objectContaining({ questionId: 'q1', source: 'profile', value: '5' })]);
  });

  it('writes an open answer only for a required question; an optional one is left blank, in review and in auto', async () => {
    for (const aiAnswers of ['review', 'auto'] as const) {
      const optional = { ...open, required: false };
      const bank = [a({ question: 'Fale sobre um projeto', answer: 'Texto salvo.' })];
      deps.proposeMatches.mockResolvedValue(new Map([['q2', { bankAnswerId: bank[0]!.id, option: null }]]));
      const res = await resolveAnswers(input([optional], bank, { aiAnswers }), deps);
      expect(deps.writeOpen).not.toHaveBeenCalled();
      expect(deps.proposeMatches).not.toHaveBeenCalled();
      expect(res.pending).toEqual([]);
      expect(res.answers).toEqual([{ questionId: 'q2', value: null, source: 'blank', category: 'open', basis: [], bankAnswerId: null }]);
    }
  });

  it('a required open question gets a proposal in review and a written answer in auto', async () => {
    const review = await resolveAnswers(input([open], [], { aiAnswers: 'review' }), deps);
    expect(review.pending).toEqual([expect.objectContaining({ kind: 'confirm_proposal', proposal: expect.objectContaining({ source: 'written' }) })]);
    expect(review.answers).toEqual([]);
    const auto = await resolveAnswers(input([open], [], { aiAnswers: 'auto' }), deps);
    expect(auto.answers).toEqual([expect.objectContaining({ questionId: 'q2', source: 'written', value: 'Porque gosto do produto.' })]);
    expect(deps.writeOpen).toHaveBeenCalledTimes(2);
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

  it('sends the worked-here question to the owner when the job company shares a word with a former employer', async () => {
    modelSays({ q1: 'profile_fact' });
    const exp = { id: 'exp_aaaaaaa1', company: 'Minsait (Indra)', title: 'Dev', start: '2020-01', end: '2022-01', location: '', achievements: [] };
    const indra = { ...ctx, company: 'Indra', job: { ...ctx.job, company: 'Indra' }, profile: { ...profile, experiences: [exp] } };
    const res = await resolveAnswers(input([select('q1', 'Have you previously worked at Indra?', ['Yes', 'No'])], [], { ctx: indra, aiAnswers: 'off' }), deps);
    expect(res.answers).toEqual([]);
    expect(res.pending).toEqual([expect.objectContaining({ category: 'profile_fact', kind: 'unanswered' })]);
  });

  it('in auto, a declined worked-here question goes straight to the owner: no saved answer, no proposal, no profile fact', async () => {
    modelSays({ q1: 'profile_fact' });
    deps.profileFacts.mockResolvedValue(new Map([['q1', { value: 'Yes', basis: ['exp_aaaaaaa1'] }]]));
    const exp = { id: 'exp_aaaaaaa1', company: 'Minsait (Indra)', title: 'Dev', start: '2020-01', end: '2022-01', location: '', achievements: [] };
    const indra = { ...ctx, company: 'Indra', job: { ...ctx.job, company: 'Indra' }, profile: { ...profile, experiences: [exp] } };
    const bank = [a({ id: 31, question: 'Have you previously worked at Indra?', answer: 'No' })];
    deps.proposeMatches.mockResolvedValue(new Map([['q1', { bankAnswerId: 31, option: 'No' }]]));
    const res = await resolveAnswers(input([select('q1', 'Have you previously worked at Indra?', ['Yes', 'No'])], bank, { ctx: indra, aiAnswers: 'auto' }), deps);
    expect(deps.profileFacts).not.toHaveBeenCalled();
    expect(deps.proposeMatches).not.toHaveBeenCalled();
    expect(res.answers).toEqual([]);
    expect(res.pending).toEqual([expect.objectContaining({ category: 'profile_fact', kind: 'unanswered', proposal: null })]);
  });

  it('treats a worked-here question by its own rule whatever category the model gives', async () => {
    modelSays({ q1: 'open' });
    const res = await resolveAnswers(input([select('q1', 'Have you previously worked at Acme?', ['Yes', 'No'])], [], { aiAnswers: 'auto' }), deps);
    expect(deps.writeOpen).not.toHaveBeenCalled();
    expect(res.answers).toEqual([expect.objectContaining({ value: 'No', source: 'rule', category: 'profile_fact' })]);
  });

  it('never offers an unanswered file question to proposeMatches', async () => {
    const bank = [a({ question: 'Cover letter', answer: 'x' })];
    const res = await resolveAnswers(input([q('q1', 'Cover letter', true, { kind: 'file' })], bank), deps);
    expect(deps.proposeMatches).not.toHaveBeenCalled();
    expect(res.pending).toEqual([expect.objectContaining({ kind: 'unanswered', category: 'file' })]);
  });

  it('a bare name field gets the first name when the step also has a last-name field', async () => {
    const res = await resolveAnswers(input([q('q1', 'Nome'), q('q2', 'Sobrenome')]), deps);
    expect(res.answers.map((x) => x.value)).toEqual(['Maria', 'Exemplo']);
    const alone = await resolveAnswers(input([q('q1', 'Nome')]), deps);
    expect(alone.answers.map((x) => x.value)).toEqual(['Maria Exemplo']);
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

  const record = (over: Partial<AnswerRecord> & Pick<AnswerRecord, 'label' | 'value' | 'source'>): AnswerRecord => ({
    questionId: 'old-id', help: '', kind: 'text', options: [], required: true, category: 'open', basis: [], bankAnswerId: null, ...over,
  });

  it('repeats the approved rehearsal answers verbatim, model answers included, in every mode', async () => {
    const approved = [record({ label: 'Why do you want to work here?', value: 'Texto aprovado.', source: 'written' })];
    for (const aiAnswers of ['off', 'review', 'auto'] as const) {
      vi.clearAllMocks();
      const res = await resolveAnswers(input([q('q1', 'Why do you want to work here?'), q('q2', 'Outra coisa')], [], { approved, aiAnswers }), deps);
      expect(res.answers).toEqual([{ questionId: 'q1', value: 'Texto aprovado.', source: 'written', category: 'open', basis: [], bankAnswerId: null }]);
      for (const spy of [deps.classify, deps.proposeMatches, deps.profileFacts]) expect(idsOf(spy.mock.calls.map((c) => c[0]))).not.toContain('q1');
      expect(deps.writeOpen.mock.calls.map((c) => c[0].id)).not.toContain('q1');
    }
  });

  it('does not repeat an approved answer when the options, the kind or the help text changed', async () => {
    const approved = [
      record({ label: 'Nível de inglês', kind: 'select', options: ['Básico', 'Fluente'], value: 'Fluente', source: 'rule', category: 'unknown' }),
      record({ label: 'Conte sobre você', help: 'Em até 200 caracteres', value: 'Texto.', source: 'written' }),
    ];
    const res = await resolveAnswers(input([select('q1', 'Nível de inglês', ['Básico', 'Intermediário', 'Fluente']),
      q('q2', 'Conte sobre você', true, { help: 'Fale do seu último projeto' })], [], { approved }), deps);
    expect(res.answers).toEqual([]);
    expect(idsOf(deps.classify.mock.calls.map((c) => c[0]))).toEqual(['q1', 'q2']);
  });

  it('repeats an approved saved answer only while the saved answer still gives the same value', async () => {
    const approved = [record({ label: 'Pronomes', value: 'ela/dela', source: 'bank', category: 'demographic', bankAnswerId: 41 })];
    const same = await resolveAnswers(input([q('q1', 'Pronomes')], [a({ id: 41, question: 'Pronomes', answer: 'ela/dela' })], { approved }), deps);
    expect(same.answers).toEqual([expect.objectContaining({ value: 'ela/dela', source: 'bank', bankAnswerId: 41 })]);

    const edited = await resolveAnswers(input([q('q1', 'Pronomes')], [a({ id: 41, question: 'Pronomes', answer: 'elu/delu' })], { approved }), deps);
    expect(edited.answers).toEqual([expect.objectContaining({ value: 'elu/delu', source: 'bank', bankAnswerId: 41 })]);

    const deleted = await resolveAnswers(input([q('q1', 'Pronomes')], [], { approved }), deps);
    expect(deleted.answers).toEqual([]);
    expect(deleted.pending).toEqual([expect.objectContaining({ kind: 'unanswered' })]);
  });

  it('lists the bank answers it used', async () => {
    const bank = [a({ id: 11, question: 'Pretensão salarial', answer: '15000' }), a({ id: 12, question: 'Pronomes', answer: 'ela/dela' }),
      a({ id: 13, question: 'Nunca usada', answer: 'x' }), a({ id: 14, question: 'Aviso prévio', answer: '30 dias' })];
    const approved = [record({ label: 'Notice period', value: '30 dias', source: 'bank', category: 'personal', bankAnswerId: 14,
      })];
    bank[3]!.aliases = [{ normalized: 'notice period', options: [], value: '30 dias' }];
    const res = await resolveAnswers(input([q('q1', 'Pretensão salarial'), q('q2', 'Pronomes'), q('q3', 'Notice period')], bank, { approved }), deps);
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
      proposal: { bankAnswerId: 21, bankQuestion: 'Seu nível de inglês', bankAnswer: 'Fluente', value: 'Fluente', source: 'bank', basis: [] } }]);
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
