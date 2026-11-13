import { describe, expect, it } from 'vitest';
import type { CandidateProfile, Question } from '@kv/shared';
import { writeOpenAnswer } from './apply-tasks';
import { verifyOpenAnswer, verifyProfileFact, yearsCovered } from './apply-verify';
import { createFakeProvider } from './fake';
import { REALISTIC_PROFILE } from './testing';

const exp1 = 'exp_aaaaaaa1';
const exp2 = 'exp_bbbbbbb2';
const now = Date.UTC(2026, 10, 15); // 2026-11

const profile: CandidateProfile = {
  ...REALISTIC_PROFILE,
  experiences: [
    { id: exp1, company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora', start: '2021-03', end: '2023-02', location: '',
      achievements: [{ id: 'ach_aaaaaaa1', text: 'Reduzi o tempo de build em 40% com Vite' },
        { id: 'ach_aaaaaaa2', text: 'Criei telas em React e TypeScript' }] },
    { id: exp2, company: 'Outra Fictícia SA', title: 'Desenvolvedora Sênior', start: '2023-06', end: '', location: '',
      achievements: [{ id: 'ach_bbbbbbb9', text: 'Mantive aplicações em React e TypeScript' }] },
  ],
};
const job = { company: 'Globex Fictícia', title: 'Engenheira Front-end', description: 'Buscamos pessoa com React e Kubernetes. Mais de 12 anos de mercado.' };

const base = { id: 'q1', label: 'Pergunta', help: '', options: [] as string[], required: true, maxLength: null };
const number = (label: string): Question => ({ ...base, label, kind: 'number' });
const bool = (label: string): Question => ({ ...base, label, kind: 'boolean' });
const sel = (label: string, options: string[]): Question => ({ ...base, label, kind: 'select', options });
const text = (label: string, maxLength: number | null = null): Question => ({ ...base, label, kind: 'text', maxLength });
const open = (extra: Partial<Question> = {}): Question => ({ ...base, label: 'Por que quer trabalhar aqui?', kind: 'longtext', ...extra });

describe('yearsCovered', () => {
  it('rounds down the union of the cited periods, an empty end meaning now', () => {
    expect(yearsCovered(profile, [exp1, exp2], now)).toBe(5);
    expect(yearsCovered(profile, [exp1], now)).toBe(1);
    expect(yearsCovered(profile, [exp2], now)).toBe(3);
    expect(yearsCovered(profile, [], now)).toBe(0);
  });

  it('does not count overlapping periods twice or the same experience twice', () => {
    const overlap: CandidateProfile = { ...profile, experiences: [
      { ...profile.experiences[0], start: '2020-01', end: '2022-01' },
      { ...profile.experiences[1], start: '2021-01', end: '2022-01' }] };
    expect(yearsCovered(overlap, [exp1, exp2, exp1], now)).toBe(2);
  });

  it('ignores unknown ids, unreadable dates, inverted and future periods', () => {
    const odd: CandidateProfile = { ...profile, experiences: [
      { ...profile.experiences[0], start: 'ontem', end: '' },
      { ...profile.experiences[1], start: '2030-01', end: '' }] };
    expect(yearsCovered(odd, [exp1, exp2, 'exp_zzzzzzzz'], now)).toBe(0);
    const inverted: CandidateProfile = { ...profile, experiences: [{ ...profile.experiences[0], start: '2023-01', end: '2021-01' }] };
    expect(yearsCovered(inverted, [exp1], now)).toBe(0);
  });

  it('reads year-only dates without adding time', () => {
    const years: CandidateProfile = { ...profile, experiences: [{ ...profile.experiences[0], start: '2015', end: '2019' }] };
    expect(yearsCovered(years, [exp1], now)).toBe(3); // 2015-12 to 2019-01
    const from2021: CandidateProfile = { ...profile, experiences: [{ ...profile.experiences[0], start: '2021-01', end: '2023' }] };
    expect(yearsCovered(from2021, [exp1], now)).toBe(2); // never more than the 24 months that may be real
  });
});

describe('verifyProfileFact', () => {
  it('bounds years of experience by the cited experiences', () => {
    expect(verifyProfileFact(profile, number('Anos de experiência com TypeScript'), { answer: '5', basis: [exp1, exp2] }, now)).toEqual({ ok: true, value: '5' });
    expect(verifyProfileFact(profile, number('Anos de experiência com TypeScript'), { answer: '6', basis: [exp1, exp2] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, number('Anos de experiência com TypeScript'), { answer: '7', basis: [exp1, exp2] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, number('Anos de experiência com TypeScript'), { answer: '3', basis: [] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, number('Anos de experiência com TypeScript'), { answer: '3', basis: [exp1] }, now).ok).toBe(false);
  });

  it('accepts only plain whole numbers', () => {
    for (const answer of ['', '-1', '2.5', '2,5', '3 anos', '1e1', '0x2', 'três']) {
      expect(verifyProfileFact(profile, number('Anos de experiência com React'), { answer, basis: [exp1, exp2] }, now).ok, answer).toBe(false);
    }
    expect(verifyProfileFact(profile, number('Anos de experiência com React'), { answer: ' 3 ', basis: [exp2] }, now)).toEqual({ ok: true, value: '3' });
  });

  it('counts only experiences, not other items, as years of work', () => {
    expect(verifyProfileFact(profile, number('Anos de experiência com React'), { answer: '1', basis: ['skill_1a2b3c4d'] }, now).ok).toBe(false);
  });

  it('refuses a number about a technology that the profile does not list, and refuses 0 (a denial needs the owner)', () => {
    expect(verifyProfileFact(profile, number('Anos de experiência com Python'), { answer: '2', basis: [exp1, exp2] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, number('Anos de experiência com Python'), { answer: '0', basis: [exp1] }, now).ok).toBe(false);
  });

  it('rejects a fact that cites an unknown item', () => {
    expect(verifyProfileFact(profile, number('Anos de experiência com React'), { answer: '1', basis: [exp1, 'exp_zzzzzzzz'] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, bool('Tem React?'), { answer: 'true', basis: ['skill_zzzzzzzz'] }, now).ok).toBe(false);
  });

  it('accepts a select answer only among the options, written as offered', () => {
    const level = sel('Nível de inglês', ['Básico', 'Avançado']);
    expect(verifyProfileFact(profile, level, { answer: 'avançado', basis: ['lang_3m4n5o6p'] }, now)).toEqual({ ok: true, value: 'Avançado' });
    expect(verifyProfileFact(profile, level, { answer: 'Fluente', basis: ['lang_3m4n5o6p'] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, sel('Nível de inglês', ['Sim', 'sim']), { answer: 'Sim', basis: [] }, now).ok).toBe(false);
  });

  it('requires a basis to affirm', () => {
    expect(verifyProfileFact(profile, bool('Tem experiência com Go?'), { answer: 'true', basis: [] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, bool('Tem experiência com React?'), { answer: 'true', basis: ['skill_1a2b3c4d'] }, now)).toEqual({ ok: true, value: true });
    expect(verifyProfileFact(profile, bool('Tem experiência com Go?'), { answer: 'false', basis: [] }, now).ok).toBe(false); // ruling: denials need the owner
    expect(verifyProfileFact(profile, bool('Tem experiência com React?'), { answer: 'Sim', basis: ['skill_1a2b3c4d'] }, now).ok).toBe(false);
  });

  it('refuses to affirm a technology that the profile does not list even with a basis', () => {
    expect(verifyProfileFact(profile, bool('Tem experiência com Kubernetes?'), { answer: 'true', basis: [exp1] }, now).ok).toBe(false);
  });

  it('does not affirm "N years" or an option with years beyond the cited experiences', () => {
    const ask = bool('Tem 5 anos de experiência com React?');
    expect(verifyProfileFact(profile, ask, { answer: 'true', basis: [exp1] }, now).ok).toBe(false);
    // Round 3: a yes/no question that states years is never affirmed (only select options carry years).
    expect(verifyProfileFact(profile, ask, { answer: 'true', basis: [exp1, exp2, 'skill_1a2b3c4d'] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, bool('Tem 6 anos de experiência com React?'), { answer: 'true', basis: [exp1, exp2, 'skill_1a2b3c4d'] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, bool('Tem 1 ano de experiência com React?'), { answer: 'true', basis: [exp1, 'skill_1a2b3c4d'] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, bool('Tem cinco anos de experiência com React?'), { answer: 'true', basis: [exp1] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, bool('Tem 99 clientes ativos?'), { answer: 'true', basis: [exp1] }, now).ok).toBe(false);
    const range = sel('Experiência com React', ['0-2 anos', '3-5 anos', '6+ anos']);
    const react = [exp1, exp2, 'skill_1a2b3c4d'];
    expect(verifyProfileFact(profile, range, { answer: '6+ anos', basis: react }, now).ok).toBe(false); // 5 years 4 months
    expect(verifyProfileFact(profile, range, { answer: '3-5 anos', basis: react }, now).ok).toBe(true);
  });

  it('requires every number of a text answer to be in a cited item, and fits maxLength', () => {
    const ask = text('Qual foi o ganho de build?', 100);
    expect(verifyProfileFact(profile, ask, { answer: 'Reduzi o build em 40%', basis: ['ach_aaaaaaa1'] }, now).ok).toBe(true);
    expect(verifyProfileFact(profile, ask, { answer: 'Reduzi o build em 70%', basis: ['ach_aaaaaaa1'] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, ask, { answer: 'Reduzi o build em 40%', basis: [exp2] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, text('Resumo', 10), { answer: 'Texto longo demais', basis: [] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, text('Resumo'), { answer: '  ', basis: [] }, now).ok).toBe(false);
  });

  it('does not take digits of ids or the phone number as facts', () => {
    expect(verifyProfileFact(profile, text('Telefone'), { answer: '91234-5678', basis: [exp1] }, now).ok).toBe(false);
  });

  it('refuses a text answer that names something outside the profile', () => {
    expect(verifyProfileFact(profile, text('Último projeto'), { answer: 'Usei Kubernetes', basis: [exp1] }, now).ok).toBe(false);
  });

  it('refuses kinds it cannot check', () => {
    expect(verifyProfileFact(profile, { ...base, kind: 'multiselect', options: ['React'] }, { answer: 'React', basis: [exp1] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, { ...base, kind: 'date' }, { answer: '2021-03', basis: [exp1] }, now).ok).toBe(false);
  });
});

const react = 'skill_1a2b3c4d';
const english = 'lang_3m4n5o6p';
const degree = 'edu_4f5g6h7j';

describe('verifyProfileFact: review round 1', () => {
  const ok = (q: Question, answer: string, basis: string[]) => verifyProfileFact(profile, q, { answer, basis }, now).ok;

  it('1. a yes/no select needs a basis and an option that the cited items support', () => {
    expect(ok(sel('Possui graduação completa?', ['Sim', 'Não']), 'Sim', [])).toBe(false);
    expect(ok(sel('Possui graduação completa?', ['Sim', 'Não']), 'Sim', [degree])).toBe(false); // no cited text says "graduação" and "completa"
    expect(ok(sel('Possui graduação completa?', ['Sim', 'Não']), 'Sim', [exp1])).toBe(false);
    // Ruling after round 3: a denial is never sent without the owner.
    expect(ok(sel('Possui graduação completa?', ['Sim', 'Não']), 'Não', [])).toBe(false);
    expect(ok(sel('Possui certificação PMP?', ['Sim', 'Não']), 'Não', [])).toBe(false);
    expect(ok(sel('Nível de inglês', ['Básico', 'Avançado', 'Fluente']), 'Fluente', [english])).toBe(false);
    expect(ok(sel('Nível de inglês', ['Básico', 'Avançado', 'Fluente']), 'Avançado', [english])).toBe(true);
    expect(ok(sel('Nível de inglês', ['Básico', 'Avançado', 'Fluente']), 'Avançado', [])).toBe(false);
  });

  it('4. only years-of-experience questions get a number', () => {
    expect(ok(number('Quantas pessoas você liderou?'), '5', [exp1, exp2])).toBe(false);
    const lead: CandidateProfile = { ...profile, experiences: [{ ...profile.experiences[0], achievements: [{ id: 'ach_lead0001', text: 'Liderei 3 pessoas' }] }, profile.experiences[1]] };
    expect(verifyProfileFact(lead, number('Quantas pessoas você liderou?'), { answer: '3', basis: ['ach_lead0001'] }, now).ok).toBe(false);
    expect(ok(number('Anos de experiência com TypeScript'), '5', [exp1, exp2])).toBe(true);
  });

  it('6. an affirmation needs a cited item that relates to the question', () => {
    expect(ok(bool('Você fala inglês fluente?'), 'true', [exp1])).toBe(false);
    expect(ok(bool('Possui ensino superior?'), 'true', [exp1])).toBe(false);
    expect(ok(bool('Possui ensino superior?'), 'true', [degree])).toBe(false);
    expect(ok(bool('Tem experiência com liderança?'), 'true', [exp2])).toBe(false);
    expect(ok(bool('Tem experiência com go?'), 'true', [exp1])).toBe(false);
    expect(ok(bool('Tem experiência com React?'), 'true', [react])).toBe(true);
  });

  it('9. a negated question is not answered', () => {
    expect(ok(bool('Você não tem experiência com Go?'), 'false', [])).toBe(false);
    expect(ok(bool('Have you never used React?'), 'true', [react])).toBe(false);
  });

  it('10. scaffolding words of a label are not subjects, content words are', () => {
    expect(ok(number('How many Years of Experience do you have with React?'), '3', [exp2])).toBe(true);
    // Round 3: "Software Development" is the subject; no cited experience says it.
    expect(ok(number('How many Years of Experience do you have with Software Development?'), '3', [exp2])).toBe(false);
  });
});

describe('verifyOpenAnswer: review round 1', () => {
  const codes = (p: CandidateProfile, qn: Question, t: string) => verifyOpenAnswer(p, job, qn, t, now).map((v) => v.code);

  it('2. technical terms of the job do not count as the candidate own, unless the profile has them', () => {
    expect(codes(profile, open(), 'Trabalhei com Kubernetes em produção.')).toContain('novel_term');
    const withK8s = { ...profile, skills: [...profile.skills, { id: 'skill_kkkkkkk1', name: 'Kubernetes' }] };
    expect(codes(withK8s, open(), 'Trabalhei com Kubernetes em produção.')).toEqual([]);
  });

  it('keeps the company, the title and profile technologies', () => {
    expect(codes(profile, open(), 'Quero trabalhar na Globex Fictícia como Engenheira Front-end, com React e TypeScript.')).toEqual([]);
  });

  it('7. a name that opens a sentence is checked when the job mentions it', () => {
    const ops = { ...job, description: 'Usamos Datadog e Grafana.' };
    const run = (t: string) => verifyOpenAnswer(profile, ops, open(), t, now).map((v) => v.code);
    expect(run('Datadog foi a ferramenta que usei.')).toContain('novel_term');
    expect(run('Uso React. Datadog também.')).toContain('novel_term');
    expect(codes(profile, open(), 'Gosto de React. Tenho interesse na vaga.')).toEqual([]);
  });

  it('8. years stated in the text cannot exceed the years the profile covers', () => {
    const six: CandidateProfile = { ...profile, experiences: [
      { ...profile.experiences[0], achievements: [{ id: 'ach_aaaaaaa1', text: 'Atendi 6 clientes' }] }, profile.experiences[1]] };
    expect(codes(six, open(), 'Tenho 6 anos de experiência.')).toContain('new_number');
    expect(codes(six, open(), 'Atendi 6 clientes.')).toEqual([]);
  });
});

describe('verifyProfileFact: review round 2, every claim covered by the cited items', () => {
  const ok = (p: CandidateProfile, q: Question, answer: string, basis: string[]) => verifyProfileFact(p, q, { answer, basis }, now).ok;
  const withEducation = (e: Partial<CandidateProfile['education'][number]>): CandidateProfile =>
    ({ ...profile, education: [{ ...profile.education[0], ...e }] });

  it('A. refuses degree and language claims that the cited text does not state', () => {
    const level = sel('Qual sua maior formação?', ['Ensino médio', 'Graduação', 'Pós-graduação']);
    expect(ok(profile, level, 'Pós-graduação', [degree])).toBe(false);
    expect(ok(withEducation({ degree: 'Ensino Médio' }), bool('Possui ensino superior completo?'), 'true', [degree])).toBe(false);
    expect(ok(withEducation({ end: '' }), sel('Possui graduação completa?', ['Sim', 'Não']), 'Sim', [degree])).toBe(false);
    expect(ok(profile, bool('Você fala inglês fluente?'), 'true', [english])).toBe(false);
    expect(ok(profile, bool('Possui inglês nativo?'), 'true', [english])).toBe(false);
    expect(ok(profile, bool('Possui graduação em engenharia?'), 'true', [degree])).toBe(false);
    expect(ok(profile, bool('Tem experiência com React e liderança de times?'), 'true', [react])).toBe(false);
  });

  it('A. accepts a claim when every stem of the question is in the cited items', () => {
    expect(ok(profile, bool('Tem experiência com React?'), 'true', [react])).toBe(true);
    expect(ok(profile, sel('Nível de inglês', ['Básico', 'Avançado']), 'Avançado', [english])).toBe(true);
    expect(ok(profile, bool('Possui inglês avançado?'), 'true', [english])).toBe(true);
    expect(ok(profile, bool('Tem experiência com ciência da computação?'), 'true', [degree])).toBe(true);
  });

  it('A. an ongoing item never supports "completed"', () => {
    const done = withEducation({ degree: 'Graduação completa', end: '2019' });
    expect(ok(done, bool('Possui graduação completa?'), 'true', [degree])).toBe(true);
    expect(ok(withEducation({ degree: 'Graduação completa', end: '' }), bool('Possui graduação completa?'), 'true', [degree])).toBe(false);
    expect(ok(withEducation({ degree: 'Graduação completa', end: '2031' }), bool('Possui graduação completa?'), 'true', [degree])).toBe(false);
  });

  it('A. short words are content: "go" is not dropped for its length', () => {
    const withGo = { ...profile, skills: [...profile.skills, { id: 'skill_gggggggg', name: 'Go' }] };
    expect(ok(withGo, bool('Tem experiência com Go?'), 'true', ['skill_gggggggg'])).toBe(true);
    expect(ok(profile, bool('Tem experiência com Go?'), 'true', [react])).toBe(false);
  });

  it('B. a number is only for years-of-experience questions', () => {
    expect(ok(profile, number('Quantas pessoas você liderou?'), '40', ['ach_aaaaaaa1'])).toBe(false);
    const atendi = { ...profile, experiences: [{ ...profile.experiences[0], achievements: [{ id: 'ach_atendi01', text: 'Atendi 40 clientes internos' }] }, profile.experiences[1]] };
    expect(ok(atendi, number('Quantas pessoas você liderou?'), '40', ['ach_atendi01'])).toBe(false);
    expect(ok(profile, number('Há quantos anos você mora em São Paulo?'), '5', [exp1, exp2])).toBe(false);
    expect(ok(profile, number('Quantos anos você tem?'), '5', [exp1, exp2])).toBe(false);
    expect(ok(profile, number('Anos de experiência com TypeScript'), '5', [exp1, exp2])).toBe(true);
    expect(ok(profile, number('Years of experience with React'), '5', [exp1, exp2])).toBe(true);
    expect(ok(profile, number('Tempo de experiência com React (anos)'), '5', [exp1, exp2])).toBe(true);
  });

  it('B. a year range option needs a basis unless the whole option is zero or a plain negative', () => {
    const range = sel('Experiência com Kubernetes', ['0-2 anos', '3-5 anos']);
    expect(ok(profile, range, '0-2 anos', [])).toBe(false);
    // Ruling after round 3: a plain negative is a denial, always refused, even for a subject the profile lacks.
    expect(ok(profile, sel('Experiência com Rust', ['0', '3-5 anos']), '0', [])).toBe(false);
    expect(ok(profile, sel('Experiência com Rust', ['Nenhum', '3-5 anos']), 'Nenhum', [])).toBe(false);
    expect(ok(profile, sel('Experiência com React', ['0', '3-5 anos']), '0', [])).toBe(false);
    expect(ok(profile, sel('Experiência com React', ['Nenhum', '3-5 anos']), 'Nenhum', [])).toBe(false);
    expect(ok(profile, sel('Experiência com React', ['0-2 anos', '3-5 anos']), '0-2 anos', [])).toBe(false);
  });
});

describe('verifyProfileFact: review round 3, the complete rule set', () => {
  const ok = (p: CandidateProfile, q: Question, answer: string, basis: string[]) => verifyProfileFact(p, q, { answer, basis }, now).ok;
  const withExp = (achievements: string[]): CandidateProfile => ({ ...profile, experiences: [
    { ...profile.experiences[0], achievements: achievements.map((t, i) => ({ id: `ach_cccccc${i}0`, text: t })) },
    { ...profile.experiences[1], achievements: [] }] });
  const withSkill = (name: string): CandidateProfile => ({ ...profile, skills: [...profile.skills, { id: 'skill_rrrrrrrr', name }] });

  it('1. a select option with digits still has its words checked', () => {
    const cloud = withExp(['Migrei os serviços para cloud AWS']);
    const ask = sel('Experiência com cloud', ['AWS 2+ anos', 'Azure 2+ anos', 'Nenhuma']);
    expect(ok(cloud, ask, 'Azure 2+ anos', [exp1, exp2])).toBe(false);
    expect(ok(cloud, sel('Experiência com cloud', ['aws 2 anos', 'azure 2 anos']), 'azure 2 anos', [exp1, exp2])).toBe(false);
    expect(ok(cloud, ask, 'azure 2 anos', [exp1, exp2])).toBe(false); // not one of the options either
    expect(ok(profile, sel('Experiência com TypeScript', ['1 ano', '3 anos liderando squad']), '3 anos liderando squad', [exp1, exp2])).toBe(false);
    expect(ok(profile, sel('Nível de inglês', ['B1', 'B2', 'C1', 'C2']), 'C2', [english])).toBe(false);
    // the supported counterparts
    expect(ok(cloud, ask, 'AWS 2+ anos', [exp1])).toBe(false); // exp1 covers 1 year
    const longCloud: CandidateProfile = { ...cloud, experiences: [{ ...cloud.experiences[0], start: '2019-01' }, cloud.experiences[1]] };
    expect(ok(longCloud, ask, 'AWS 2+ anos', [exp1])).toBe(true);
    expect(ok(profile, sel('Experiência com TypeScript', ['1 ano', '3 anos']), '3 anos', [exp1, exp2])).toBe(true);
    expect(ok(profile, sel('Experiência com TypeScript', ['1 ano', '6 anos']), '6 anos', [exp1, exp2])).toBe(false);
  });

  it('2. a claim is never collected across unrelated cited items', () => {
    const posVenda = withExp(['Atendi clientes no pós-venda']);
    const graduacao = { ...posVenda, education: [{ ...profile.education[0], degree: 'Graduação em Sistemas' }] };
    expect(ok(graduacao, bool('Possui pós-graduação?'), 'true', [degree, exp1])).toBe(false);
    expect(ok(graduacao, bool('Possui pós graduação?'), 'true', [degree, exp1])).toBe(false);
    const pos = { ...profile, education: [{ ...profile.education[0], degree: 'Pós-graduação em Sistemas' }] };
    expect(ok(pos, bool('Possui pós-graduação?'), 'true', [degree])).toBe(true);
    expect(ok(pos, bool('Possui pós graduação?'), 'true', [degree])).toBe(false); // the item has the compound, not two words: refused
    expect(ok({ ...profile, education: [{ ...profile.education[0], degree: 'Pós graduação em Sistemas' }] },
      bool('Possui pós-graduação?'), 'true', [degree])).toBe(true); // hyphen and space compare equal
    // two words of the question in two different items
    expect(ok(profile, bool('Tem experiência com React e Vite?'), 'true', [react, exp2])).toBe(false);
    // an experience is one item: its title, company and achievements together
    expect(ok(profile, bool('Tem experiência com React e Vite?'), 'true', [exp1])).toBe(true);
  });

  it('3. a number checks the subject of the question', () => {
    expect(ok(profile, number('Anos de experiência com liderança de equipes'), '5', [exp1, exp2])).toBe(false);
    expect(ok(profile, number('Anos de experiência com rust'), '5', [exp1, exp2])).toBe(false);
    expect(ok(profile, number('Há quantos anos trabalha remoto?'), '5', [exp1, exp2])).toBe(false);
    expect(ok(REALISTIC_PROFILE, number('Anos de experiência com Java'), '5', ['exp_k3j9x0aq', 'exp_bbbbbbb2'])).toBe(false);
    expect(ok(REALISTIC_PROFILE, number('Anos de experiência com Java'), '0', ['exp_k3j9x0aq'])).toBe(false); // the Java skill exists
  });

  it('accepts the supported positives', () => {
    expect(ok(profile, number('Anos de experiência com TypeScript'), '5', [exp1, exp2])).toBe(true);
    const plain = withExp(['Reduzi o tempo de build em 40% com Vite']);
    expect(ok(plain, number('Anos de experiência com TypeScript'), '1', [exp1, exp2])).toBe(false);
    expect(ok(profile, bool('Tem experiência com React?'), 'true', [react])).toBe(true);
    expect(ok(profile, sel('Nível de inglês', ['Básico', 'Intermediário', 'Avançado']), 'Avançado', [english])).toBe(true);
    // Ruling after round 3: denials are refused even when nothing in the profile mentions the subject.
    expect(ok(profile, bool('Tem experiência com Rust?'), 'false', [])).toBe(false);
    expect(ok(withSkill('Rust'), bool('Tem experiência com Rust?'), 'false', [])).toBe(false);
    expect(ok(profile, number('Anos de experiência com Rust'), '0', [])).toBe(false);
    expect(ok(withSkill('Rust'), number('Anos de experiência com Rust'), '0', [])).toBe(false);
  });

  it('a remote-work question is answered only from an experience that says remoto', () => {
    expect(ok(profile, number('Há quantos anos trabalha remoto?'), '1', [exp1, exp2])).toBe(false);
    const remote = withExp(['Trabalho remoto com clientes da Europa']);
    expect(ok(remote, number('Há quantos anos trabalha remoto?'), '1', [exp1, exp2])).toBe(true);
    expect(ok(remote, number('Há quantos anos trabalha remoto?'), '2', [exp1, exp2])).toBe(false); // only exp1 counts: 1 year
    expect(ok(remote, number('Há quantos anos trabalha remoto?'), '0', [])).toBe(false);
  });

  it('always refuses negated questions and the kinds it cannot check', () => {
    expect(ok(profile, number('Anos sem experiência com React'), '0', [])).toBe(false);
    expect(ok(profile, bool("Haven't you used Rust?"), 'false', [])).toBe(false);
    expect(ok(profile, { ...base, kind: 'file' }, 'cv.pdf', [exp1])).toBe(false);
  });

  it('text answers come from one cited item', () => {
    const ask = text('Qual foi o ganho de build?', 100);
    expect(ok(profile, ask, 'Reduzi o tempo de build em 40%', [exp1])).toBe(true);
    expect(ok(profile, ask, 'Reduzi o tempo de build em 40% com Webpack', [exp1])).toBe(false);
    expect(ok(profile, ask, 'Reduzi o build em 40% com React', [exp1, react])).toBe(true); // all in exp1
    expect(ok(profile, ask, 'Reduzi o build em 40% com Node', [exp1, 'skill_9i0j1k2l'])).toBe(false); // Node is in another item
    expect(ok(profile, ask, 'Reduzi o build em 40%', [])).toBe(false);
  });

  describe('probes', () => {
    it('an affirmation with one unsupported word is refused', () => {
      expect(ok(profile, bool('Tem experiência com React Native?'), 'true', [react])).toBe(false);
      expect(ok(profile, bool('Tem experiência sênior com React?'), 'true', [react])).toBe(false);
      expect(ok(profile, bool('Possui inglês avançado e espanhol?'), 'true', [english])).toBe(false);
      expect(ok(profile, bool('Tem experiência com front-end?'), 'true', [exp1])).toBe(false); // front-end only in the summary
      expect(ok(profile, bool('Tem experiência?'), 'true', [exp1])).toBe(false); // no subject at all
      expect(ok(profile, sel('Tem experiência?', ['Sim', 'Não']), 'Sim', [exp1])).toBe(false);
    });

    it('options carrying levels or years are refused unless one item states them', () => {
      expect(ok(profile, sel('Experiência com React', ['Júnior', 'Pleno', 'Sênior']), 'Sênior', [react])).toBe(false);
      expect(ok(profile, sel('Experiência com React', ['React avançado', 'React básico']), 'React avançado', [react])).toBe(false);
      expect(ok(profile, sel('Experiência com React', ['Mais de 5 anos', 'Menos de 5 anos']), 'Mais de 5 anos', [react, exp1, exp2])).toBe(false);
      expect(ok(profile, sel('Anos de experiência com React', ['1-2', '3-5']), '3-5', [react, exp1, exp2])).toBe(true); // years from the question
      expect(ok(profile, sel('Experiência com React', ['1-2', '3-5']), '3-5', [react, exp1, exp2])).toBe(false); // nothing says these are years
      expect(ok(profile, sel('Clientes atendidos', ['10', '40']), '40', ['ach_aaaaaaa1'])).toBe(false); // a number that is not years
      expect(ok(profile, sel('Experiência com React', ['3–5 anos', '6+ anos']), '6+ anos', [react, exp1, exp2])).toBe(false);
      expect(ok(profile, sel('Experiência com Vite', ['1+ anos', '3+ anos']), '3+ anos', [exp1, exp2])).toBe(false); // Vite only in exp1: 1 year
    });

    it('denials are refused, whether or not the profile has the subject', () => {
      expect(ok(profile, bool('Tem experiência com Vite?'), 'false', [])).toBe(false); // in an achievement
      expect(ok(profile, bool('Fala inglês?'), 'false', [])).toBe(false);
      expect(ok(profile, bool('Possui ensino superior?'), 'false', [])).toBe(false); // education exists
      expect(ok(withSkill('React/Redux'), bool('Tem experiência com Redux?'), 'false', [])).toBe(false); // part of a slashed skill
      expect(ok(profile, bool('Tem experiência com React em produção?'), 'false', [])).toBe(false); // React is there
      expect(ok(profile, sel('Nível de inglês', ['Nenhum', 'Básico']), 'Nenhum', [])).toBe(false);
      expect(ok(profile, bool('Já trabalhou na Outra Fictícia?'), 'false', [])).toBe(false);
      expect(ok(profile, bool('Tem 5 anos de experiência?'), 'false', [])).toBe(false);
      expect(ok(profile, bool('Tem experiência com Elixir?'), 'false', [exp1])).toBe(false); // nothing mentions Elixir, still refused
      expect(ok(profile, sel('Experiência com Elixir', ['Nenhuma', '1+ anos']), 'Nenhuma', [])).toBe(false);
      expect(ok(profile, sel('Tem cinco anos de experiência?', ['Sim', 'Não']), 'Não', [])).toBe(false);
    });

    it('numbers for a subject no cited experience mentions are refused', () => {
      expect(ok(profile, number('Anos de experiência com Vite'), '1', [exp2])).toBe(false);
      expect(ok(profile, number('Anos de experiência com Vite'), '1', [exp1])).toBe(true);
      expect(ok(profile, number('Anos de experiência com React'), '3', [react])).toBe(false);
      expect(ok(profile, number('Anos de experiência com Vite'), '0', [exp2])).toBe(false); // Vite is in the profile
      expect(ok(profile, number('Anos de experiência'), '0', [])).toBe(false);
      expect(ok(profile, number('Anos de experiência'), '5', [exp1, exp2])).toBe(true);
      expect(ok(profile, number('Anos de experiência com React e Kubernetes'), '1', [exp1, exp2])).toBe(false);
    });

    it('text answers that add a word are refused', () => {
      expect(ok(profile, text('Stack'), 'React e TypeScript e Go', [exp1])).toBe(false);
      expect(ok(profile, text('Stack'), 'React', [react])).toBe(true);
      expect(ok(profile, text('Stack'), 'React avançado', [react])).toBe(false);
      expect(ok(profile, text('Experiência'), 'Tenho 40 anos de experiência com build', [exp1])).toBe(false); // "40" is a percentage
      expect(ok(profile, text('Experiência'), 'Não reduzi o build', [exp1])).toBe(false);
    });

    it('"completed" needs a finished item even in an option', () => {
      const done = { ...profile, education: [{ ...profile.education[0], degree: 'Graduação em Sistemas', end: '2019' }] };
      const ongoing = { ...profile, education: [{ ...profile.education[0], degree: 'Graduação em Sistemas', end: '' }] };
      const ask = sel('Graduação', ['Completa', 'Em andamento']);
      expect(ok(done, ask, 'Completa', [degree])).toBe(false); // "completa" is not written in the item
      const doneWord = { ...done, education: [{ ...done.education[0], degree: 'Graduação completa em Sistemas' }] };
      expect(ok(doneWord, ask, 'Completa', [degree])).toBe(true);
      expect(ok({ ...doneWord, education: [{ ...doneWord.education[0], end: '2030' }] }, ask, 'Completa', [degree])).toBe(false);
      expect(ok({ ...doneWord, education: [{ ...doneWord.education[0], end: 'em breve' }] }, ask, 'Completa', [degree])).toBe(false);
      expect(ok(ongoing, sel('Graduação', ['Concluída', 'Cursando']), 'Concluída', [degree])).toBe(false);
    });
  });
});

describe('verifyOpenAnswer: review round 2', () => {
  const run = (j: typeof job, t: string) => verifyOpenAnswer(profile, j, open(), t, now).map((v) => v.code);
  const ops = { ...job, description: 'Usamos Datadog e Grafana.' };

  it('C. names after a bullet are sentence starts', () => {
    expect(run(ops, 'Usei:\n• Datadog\n• Grafana')).toContain('novel_term');
    expect(run(ops, '- Datadog no dia a dia.')).toContain('novel_term');
    expect(run(ops, 'Ferramentas que usei:\n- Datadog\n- Grafana')).toContain('novel_term');
    expect(run(ops, '1. Datadog')).toContain('novel_term');
  });

  it('C. a lower-case word of the job does not vouch for a capitalised name', () => {
    const stack = { ...job, description: 'Stack: rust, vue e react.' };
    expect(run(stack, 'Tenho experiência com Rust e Vue.')).toContain('novel_term');
    expect(run(stack, 'Rust é minha linguagem.')).toContain('novel_term');
  });

  it('C. a technology the job lists is not the candidate own in any case or position', () => {
    const listed = { ...job, description: 'Experiência com Vue.js e RUST.' };
    expect(run(listed, 'Tenho experiência com rust e vue.')).toContain('novel_term');
  });

  it('C. ordinary sentence openers pass', () => {
    expect(run(job, 'Gostaria de fazer parte da Globex Fictícia, onde posso crescer.')).toEqual([]);
    expect(run(job, 'Trabalhar com React me motiva.')).toEqual([]);
    expect(run(job, 'Interesso-me pela vaga. Desejo crescer.')).toEqual([]);
  });

  it('C. an opener that the job description contains is refused', () => {
    expect(run({ ...job, description: 'Vamos trabalhar em equipe.' }, 'Trabalhar com React me motiva.')).toContain('novel_term');
  });
});

describe('verifyOpenAnswer', () => {
  const codes = (p: CandidateProfile, j: typeof job, qn: Question, t: string) => verifyOpenAnswer(p, j, qn, t).map((v) => v.code);

  it('blocks numbers and names that are not in the profile', () => {
    expect(codes(profile, job, open(), 'Aumentei as vendas em 340%.')).toContain('new_number');
    expect(codes(profile, job, open(), 'Trabalhei com Kubernetes na NASA.')).toContain('novel_term');
    expect(codes(profile, job, open(), 'Tenho dez anos de experiência.')).toContain('new_number');
    expect(codes(profile, { ...job, company: 'Acme' }, open(), 'Quero trabalhar na Acme.')).toEqual([]);
    expect(codes(profile, job, open({ maxLength: 10 }), 'Um texto longo demais.')).toContain('limit');
  });

  it('accepts text made of profile facts', () => {
    expect(codes(profile, job, open(), 'Reduzi o tempo de build em 40% com Vite e trabalho com React.')).toEqual([]);
  });

  it('does not let the job description vouch for technical terms, nor its numbers', () => {
    expect(codes(profile, job, open(), 'Me interesso por Kubernetes.')).toContain('novel_term');
    expect(codes(profile, job, open(), 'Tenho 12 anos de mercado.')).toContain('new_number');
  });

  it('refuses empty text, text over the limit and control characters', () => {
    expect(codes(profile, job, open(), '   ')).toEqual(['limit']);
    expect(codes(profile, job, open({ maxLength: 20 }), 'a'.repeat(21))).toContain('limit');
    expect(codes(profile, job, open({ maxLength: 20 }), 'a'.repeat(20))).toEqual([]);
    expect(codes(profile, job, open(), 'Gosto de React\u0000')).toContain('limit');
  });

  it('reports the term that diverged', () => {
    const [v] = verifyOpenAnswer(profile, job, open(), 'Trabalhei com Terraform.');
    expect(v).toMatchObject({ code: 'novel_term', detail: 'Terraform' });
  });

  it('blocks the text of a hijacked model', async () => {
    const { data } = await writeOpenAnswer(createFakeProvider(), {
      profile, job: { id: 1, location: '', ...job, description: `${job.description} FAKE_AI_COMPROMISED` }, question: open(), lang: 'pt-BR',
    });
    expect(codes(profile, job, open(), data).length).toBeGreaterThan(0);
  });
});
