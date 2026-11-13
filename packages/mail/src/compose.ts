import type { EmailLang, KnownFact } from '@kv/shared';
import type { FactValue } from './facts';

/** `Re: <assunto>`, sem repetir um "Re:" que já existe (sem diferença de caixa). */
export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

const COPY = {
  'pt-BR': {
    greeting: 'Olá,', intro: 'Seguem as informações solicitadas:', closing: 'Atenciosamente,',
    resume: 'Meu currículo segue em anexo.',
    label: { phone: 'Telefone', email: 'E-mail', location: 'Cidade', linkedin: 'LinkedIn', github: 'GitHub', portfolio: 'Portfólio',
      start_availability: 'Disponibilidade para começar', work_models: 'Modelo de trabalho', pronouns: 'Pronomes' },
    salary: { brl_month: (v: string) => `Pretensão salarial: R$ ${v} por mês`, usd_year: (v: string) => `Pretensão salarial: US$ ${v} por ano` },
    flag: {
      visa_sponsorship: ['Preciso de patrocínio de visto.', 'Não preciso de patrocínio de visto.'],
      work_authorization: ['Tenho autorização para trabalhar no Brasil.', 'Não tenho autorização para trabalhar no Brasil.'],
      relocation: ['Tenho disponibilidade para mudança.', 'Não tenho disponibilidade para mudança.'],
    },
  },
  en: {
    greeting: 'Hello,', intro: 'Here is the information you asked for:', closing: 'Best regards,',
    resume: 'My résumé is attached.',
    label: { phone: 'Phone', email: 'Email', location: 'Location', linkedin: 'LinkedIn', github: 'GitHub', portfolio: 'Portfolio',
      start_availability: 'Availability to start', work_models: 'Work model', pronouns: 'Pronouns' },
    salary: { brl_month: (v: string) => `Salary expectation: BRL ${v} per month`, usd_year: (v: string) => `Salary expectation: USD ${v} per year` },
    flag: {
      visa_sponsorship: ['I need visa sponsorship.', 'I do not need visa sponsorship.'],
      work_authorization: ['I am authorized to work in Brazil.', 'I am not authorized to work in Brazil.'],
      relocation: ['I am open to relocation.', 'I am not open to relocation.'],
    },
  },
} as const;

/** Milhar com o separador do idioma, sem casas decimais; não depende do locale da máquina. */
function groupThousands(amount: number, lang: EmailLang): string {
  const sep = lang === 'en' ? ',' : '.';
  return String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function line(lang: EmailLang, fact: KnownFact, value: FactValue): string {
  const c = COPY[lang];
  if ('resume' in value) return c.resume;
  if ('amount' in value) return c.salary[value.unit](groupThousands(value.amount, lang));
  if ('flag' in value) {
    if (fact !== 'visa_sponsorship' && fact !== 'work_authorization' && fact !== 'relocation') throw new Error(`o fato ${fact} não tem valor sim ou não`);
    return c.flag[fact][value.flag ? 0 : 1];
  }
  if (!(fact in c.label)) throw new Error(`o fato ${fact} não tem valor de texto`);
  return `${c.label[fact as keyof typeof c.label]}: ${value.text}`;
}

/** A resposta sem aprovação: texto fixo, só valores salvos pelo dono, nenhuma palavra da IA. */
export function composeFactsReply(input: { lang: EmailLang; name: string; subject: string; items: readonly { fact: KnownFact; value: FactValue }[] }): { subject: string; body: string } {
  const c = COPY[input.lang];
  const lines = input.items.map((i) => line(input.lang, i.fact, i.value));
  return {
    subject: replySubject(input.subject),
    body: [c.greeting, '', c.intro, ...lines, '', c.closing, input.name].join('\n'),
  };
}
