import type { CandidateProfile } from '@kv/shared';
import { describe, expect, it } from 'vitest';
import { resolveFact, type FactSources } from './facts';

const profile: CandidateProfile = {
  contact: { name: 'Maria Exemplo da Silva', email: 'maria@example.com', phone: '+55 11 90000-0000', location: 'São Paulo, SP' },
  summary: '', experiences: [], education: [], skills: [], languages: [], certifications: [],
  links: [
    { id: 'link-1', label: 'LinkedIn', url: 'https://www.linkedin.com/in/maria-exemplo' },
    { id: 'link-2', label: 'GitHub', url: 'https://github.com/maria-exemplo' },
    { id: 'link-3', label: 'Site', url: 'https://maria.example.com' },
  ],
};
const ans = (key: string, answer: string, kind = 'text', country: string | null = null, scope = 'always') => ({ key, answer, kind, scope, country });
const src: FactSources = {
  profile, country: 'BR', hasResume: true,
  answers: [
    ans('salary_brl_month', '20000', 'number'), ans('salary_usd_year', '90000', 'number'),
    ans('work_authorization', 'Sim', 'boolean', 'BR'), ans('visa_sponsorship', 'Não', 'boolean'), ans('relocation', 'yes', 'boolean'),
    ans('start_availability', 'em 30 dias'), ans('work_models', 'Remoto\nHíbrido'), ans('pronouns', 'ela/dela'),
  ],
};

describe('resolveFact', () => {
  it('reads contact facts and links from the profile', () => {
    expect(resolveFact('phone', src)).toEqual({ text: '+55 11 90000-0000' });
    expect(resolveFact('email', src)).toEqual({ text: 'maria@example.com' });
    expect(resolveFact('location', src)).toEqual({ text: 'São Paulo, SP' });
    expect(resolveFact('linkedin', src)).toEqual({ text: 'https://www.linkedin.com/in/maria-exemplo' });
    expect(resolveFact('github', src)).toEqual({ text: 'https://github.com/maria-exemplo' });
    expect(resolveFact('portfolio', src)).toEqual({ text: 'https://maria.example.com' });
  });
  it('picks the salary answer by the job country', () => {
    expect(resolveFact('salary', { ...src, country: 'BR' })).toEqual({ amount: 20000, unit: 'brl_month' });
    expect(resolveFact('salary', { ...src, country: 'INT' })).toEqual({ amount: 90000, unit: 'usd_year' });
  });
  it('reads booleans and text from the saved answers', () => {
    expect(resolveFact('work_authorization', src)).toEqual({ flag: true });
    expect(resolveFact('visa_sponsorship', src)).toEqual({ flag: false });
    expect(resolveFact('relocation', src)).toEqual({ flag: true });
    expect(resolveFact('start_availability', src)).toEqual({ text: 'em 30 dias' });
    expect(resolveFact('work_models', src)).toEqual({ text: 'Remoto, Híbrido' });
    expect(resolveFact('pronouns', src)).toEqual({ text: 'ela/dela' });
    expect(resolveFact('resume', src)).toEqual({ resume: true });
  });
  it('has no value for what the owner did not save', () => {
    expect(resolveFact('start_availability', { ...src, answers: [] })).toBeNull();
    expect(resolveFact('phone', { ...src, profile: { ...src.profile, contact: { ...src.profile.contact, phone: '' } } })).toBeNull();
    expect(resolveFact('resume', { ...src, hasResume: false })).toBeNull();
    expect(resolveFact('portfolio', { ...src, profile: { ...src.profile, links: src.profile.links.slice(0, 2) } })).toBeNull();
    expect(resolveFact('pronouns', { ...src, answers: [ans('pronouns', '   ')] })).toBeNull();
    expect(resolveFact('relocation', { ...src, answers: [ans('relocation', 'talvez', 'boolean')] })).toBeNull();
    expect(resolveFact('salary', { ...src, answers: [ans('salary_brl_month', '20.000', 'number')] })).toBeNull();
    // Com centavos, o texto da resposta arredondaria para um valor que o dono não salvou.
    expect(resolveFact('salary', { ...src, answers: [ans('salary_brl_month', '20000.5', 'number')] })).toBeNull();
    expect(resolveFact('salary', { ...src, answers: [ans('salary_brl_month', '20000,50', 'number')] })).toBeNull();
    expect(resolveFact('salary', { ...src, answers: [ans('salary_brl_month', '20000.00', 'number')] })).toEqual({ amount: 20000, unit: 'brl_month' });
  });
  it('ignores answers scoped to a company or to another country', () => {
    expect(resolveFact('work_authorization', { ...src, country: 'INT' })).toBeNull();
    expect(resolveFact('start_availability', { ...src, answers: [ans('start_availability', 'amanhã', 'text', null, 'company')] })).toBeNull();
  });
  it('prefers the answer of the job country over the one for any country', () => {
    const answers = [ans('start_availability', 'qualquer', 'text'), ans('start_availability', 'no Brasil', 'text', 'BR')];
    expect(resolveFact('start_availability', { ...src, answers })).toEqual({ text: 'no Brasil' });
    expect(resolveFact('start_availability', { ...src, answers, country: 'INT' })).toEqual({ text: 'qualquer' });
  });
});
