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
      achievements: [{ id: 'ach_aaaaaaa1', text: 'Reduzi o tempo de build em 40% com Vite' }] },
    { id: exp2, company: 'Outra Fictícia SA', title: 'Desenvolvedora Sênior', start: '2023-06', end: '', location: '', achievements: [] },
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
    expect(verifyProfileFact(profile, number('Anos com TypeScript'), { answer: '5', basis: [exp1, exp2] }, now)).toEqual({ ok: true, value: '5' });
    expect(verifyProfileFact(profile, number('Anos com TypeScript'), { answer: '6', basis: [exp1, exp2] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, number('Anos com TypeScript'), { answer: '7', basis: [exp1, exp2] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, number('Anos com TypeScript'), { answer: '3', basis: [] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, number('Anos com TypeScript'), { answer: '3', basis: [exp1] }, now).ok).toBe(false);
  });

  it('accepts only plain whole numbers', () => {
    for (const answer of ['', '-1', '2.5', '2,5', '3 anos', '1e1', '0x2', 'três']) {
      expect(verifyProfileFact(profile, number('Anos com React'), { answer, basis: [exp1, exp2] }, now).ok, answer).toBe(false);
    }
    expect(verifyProfileFact(profile, number('Anos com React'), { answer: ' 3 ', basis: [exp2] }, now)).toEqual({ ok: true, value: '3' });
  });

  it('counts only experiences, not other items, as years of work', () => {
    expect(verifyProfileFact(profile, number('Anos com React'), { answer: '1', basis: ['skill_1a2b3c4d'] }, now).ok).toBe(false);
  });

  it('refuses a number about a technology that the profile does not list', () => {
    expect(verifyProfileFact(profile, number('Anos de experiência com Python'), { answer: '2', basis: [exp1, exp2] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, number('Anos de experiência com Python'), { answer: '0', basis: [exp1] }, now).ok).toBe(true);
  });

  it('rejects a fact that cites an unknown item', () => {
    expect(verifyProfileFact(profile, number('Anos com React'), { answer: '1', basis: [exp1, 'exp_zzzzzzzz'] }, now).ok).toBe(false);
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
    expect(verifyProfileFact(profile, bool('Tem experiência com Go?'), { answer: 'false', basis: [] }, now)).toEqual({ ok: true, value: false });
    expect(verifyProfileFact(profile, bool('Tem experiência com React?'), { answer: 'Sim', basis: ['skill_1a2b3c4d'] }, now).ok).toBe(false);
  });

  it('refuses to affirm a technology that the profile does not list even with a basis', () => {
    expect(verifyProfileFact(profile, bool('Tem experiência com Kubernetes?'), { answer: 'true', basis: [exp1] }, now).ok).toBe(false);
  });

  it('does not affirm "N years" or an option with years beyond the cited experiences', () => {
    const ask = bool('Tem 5 anos de experiência com React?');
    expect(verifyProfileFact(profile, ask, { answer: 'true', basis: [exp1] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, ask, { answer: 'true', basis: [exp1, exp2, 'skill_1a2b3c4d'] }, now).ok).toBe(true);
    expect(verifyProfileFact(profile, bool('Tem 6 anos de experiência com React?'), { answer: 'true', basis: [exp1, exp2, 'skill_1a2b3c4d'] }, now).ok).toBe(false);
    expect(verifyProfileFact(profile, bool('Tem 1 ano de experiência com React?'), { answer: 'true', basis: [exp1, 'skill_1a2b3c4d'] }, now).ok).toBe(true);
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
    expect(ok(sel('Possui graduação completa?', ['Sim', 'Não']), 'Sim', [degree])).toBe(true);
    expect(ok(sel('Possui graduação completa?', ['Sim', 'Não']), 'Sim', [exp1])).toBe(false);
    expect(ok(sel('Possui graduação completa?', ['Sim', 'Não']), 'Não', [])).toBe(true);
    expect(ok(sel('Nível de inglês', ['Básico', 'Avançado', 'Fluente']), 'Fluente', [english])).toBe(false);
    expect(ok(sel('Nível de inglês', ['Básico', 'Avançado', 'Fluente']), 'Avançado', [english])).toBe(true);
    expect(ok(sel('Nível de inglês', ['Básico', 'Avançado', 'Fluente']), 'Avançado', [])).toBe(false);
  });

  it('4. a number that is not about years must be in a cited item', () => {
    expect(ok(number('Quantas pessoas você liderou?'), '5', [exp1, exp2])).toBe(false);
    const lead: CandidateProfile = { ...profile, experiences: [{ ...profile.experiences[0], achievements: [{ id: 'ach_lead0001', text: 'Liderei 3 pessoas' }] }, profile.experiences[1]] };
    expect(verifyProfileFact(lead, number('Quantas pessoas você liderou?'), { answer: '3', basis: ['ach_lead0001'] }, now).ok).toBe(true);
    expect(verifyProfileFact(lead, number('Quantas pessoas você liderou?'), { answer: '5', basis: [exp1] }, now).ok).toBe(false);
    expect(ok(number('Quantas pessoas você liderou?'), '3', [])).toBe(false);
    expect(ok(number('Anos de experiência com TypeScript'), '5', [exp1, exp2])).toBe(true);
  });

  it('6. an affirmation needs a cited item that relates to the question', () => {
    expect(ok(bool('Você fala inglês fluente?'), 'true', [exp1])).toBe(false);
    expect(ok(bool('Possui ensino superior?'), 'true', [exp1])).toBe(false);
    expect(ok(bool('Possui ensino superior?'), 'true', [degree])).toBe(true);
    expect(ok(bool('Tem experiência com liderança?'), 'true', [exp2])).toBe(false);
    expect(ok(bool('Tem experiência com go?'), 'true', [exp1])).toBe(false);
    expect(ok(bool('Tem experiência com React?'), 'true', [react])).toBe(true);
  });

  it('9. a negated question is not answered', () => {
    expect(ok(bool('Você não tem experiência com Go?'), 'false', [])).toBe(false);
    expect(ok(bool('Have you never used React?'), 'true', [react])).toBe(false);
  });

  it('10. common title-case words in a label are not unknown subjects', () => {
    expect(ok(number('How many Years of Experience do you have with Software Development?'), '3', [exp2])).toBe(true);
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

  it('7. a proper name that opens a sentence is checked', () => {
    expect(codes(profile, open(), 'Datadog foi a ferramenta que usei.')).toContain('novel_term');
    expect(codes(profile, open(), 'Uso React. Datadog também.')).toContain('novel_term');
    expect(codes(profile, open(), 'Gosto de React. Tenho interesse na vaga.')).toEqual([]);
  });

  it('8. years stated in the text cannot exceed the years the profile covers', () => {
    const six: CandidateProfile = { ...profile, experiences: [
      { ...profile.experiences[0], achievements: [{ id: 'ach_aaaaaaa1', text: 'Atendi 6 clientes' }] }, profile.experiences[1]] };
    expect(codes(six, open(), 'Tenho 6 anos de experiência.')).toContain('new_number');
    expect(codes(six, open(), 'Atendi 6 clientes.')).toEqual([]);
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
