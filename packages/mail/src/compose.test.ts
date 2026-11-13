import { KNOWN_FACTS, type EmailLang, type KnownFact } from '@kv/shared';
import { describe, expect, it } from 'vitest';
import { composeFactsReply, replySubject } from './compose';
import type { FactValue } from './facts';

describe('replySubject', () => {
  it('adds Re: once, whatever the case', () => {
    expect(replySubject('Pretensão salarial')).toBe('Re: Pretensão salarial');
    expect(replySubject('RE: A few questions')).toBe('RE: A few questions');
    expect(replySubject('re: oi')).toBe('re: oi');
  });
});

describe('composeFactsReply', () => {
  it('writes the fixed text in Portuguese', () => {
    expect(composeFactsReply({ lang: 'pt-BR', name: 'Maria Exemplo da Silva', subject: 'Pretensão salarial',
      items: [{ fact: 'salary', value: { amount: 20000, unit: 'brl_month' } }, { fact: 'start_availability', value: { text: 'em 30 dias' } }] }))
      .toEqual({ subject: 'Re: Pretensão salarial',
        body: 'Olá,\n\nSeguem as informações solicitadas:\nPretensão salarial: R$ 20.000 por mês\nDisponibilidade para começar: em 30 dias\n\nAtenciosamente,\nMaria Exemplo da Silva' });
  });
  it('writes the fixed text in English', () => {
    expect(composeFactsReply({ lang: 'en', name: 'Maria Exemplo da Silva', subject: 'RE: A few questions',
      items: [{ fact: 'visa_sponsorship', value: { flag: false } }, { fact: 'resume', value: { resume: true } }] }))
      .toEqual({ subject: 'RE: A few questions',
        body: 'Hello,\n\nHere is the information you asked for:\nI do not need visa sponsorship.\nMy résumé is attached.\n\nBest regards,\nMaria Exemplo da Silva' });
  });
  it('formats the salary with the thousands separator of the language and no decimals', () => {
    const one = (lang: EmailLang, value: FactValue) => composeFactsReply({ lang, name: 'M', subject: 's', items: [{ fact: 'salary', value }] }).body.split('\n')[3];
    expect(one('pt-BR', { amount: 1234567, unit: 'brl_month' })).toBe('Pretensão salarial: R$ 1.234.567 por mês');
    expect(one('en', { amount: 90000, unit: 'usd_year' })).toBe('Salary expectation: USD 90,000 per year');
    expect(one('pt-BR', { amount: 950, unit: 'usd_year' })).toBe('Pretensão salarial: US$ 950 por ano');
    expect(one('en', { amount: 20000.5, unit: 'brl_month' })).toBe('Salary expectation: BRL 20,001 per month');
  });
  it('has a line for every known fact in both languages', () => {
    const value = (fact: KnownFact, flag: boolean): FactValue => {
      if (fact === 'salary') return { amount: 1000, unit: 'brl_month' };
      if (fact === 'resume') return { resume: true };
      if (fact === 'visa_sponsorship' || fact === 'work_authorization' || fact === 'relocation') return { flag };
      return { text: 'valor' };
    };
    for (const lang of ['pt-BR', 'en'] as const) {
      for (const fact of KNOWN_FACTS) {
        for (const flag of [true, false]) {
          const { body } = composeFactsReply({ lang, name: 'M', subject: 's', items: [{ fact, value: value(fact, flag) }] });
          expect(body.split('\n')[3].trim()).not.toBe('');
        }
      }
    }
  });
  it('says yes and no differently', () => {
    const body = (flag: boolean) => composeFactsReply({ lang: 'en', name: 'M', subject: 's', items: [{ fact: 'relocation', value: { flag } }] }).body;
    expect(body(true)).toContain('I am open to relocation.');
    expect(body(false)).toContain('I am not open to relocation.');
  });
});
