import { describe, expect, it } from 'vitest';
import { filterMail, type FilterContext } from './filter';
import { rawMail } from './testing';

const ctx: FilterContext = {
  ownAddress: 'maria@example.com',
  knownThreads: new Set(),
  companies: [{ company: 'Acme', title: 'Engenheira de Software' }, { company: 'Nu', title: 'Backend Engineer' }],
};

describe('filterMail', () => {
  it('drops the owner own mail and lists without keeping them', () => {
    expect(filterMail(rawMail({ from: { address: 'maria@example.com', name: 'Maria' } }), ctx)).toEqual({ pass: false, ignoredCompany: null });
    expect(filterMail(rawMail({ from: { address: 'news@acme.com', name: 'Acme' }, listId: true, subject: 'Vagas da semana' }), ctx)).toEqual({ pass: false, ignoredCompany: null });
  });
  it('passes a reply in a known thread before any other rule', () => {
    expect(filterMail(rawMail({ threadKey: 't1', listId: true }), { ...ctx, knownThreads: new Set(['t1']) })).toEqual({ pass: true, why: 'thread' });
  });
  it('passes a known application system', () => {
    expect(filterMail(rawMail({ from: { address: 'no-reply@us.greenhouse-mail.io', name: 'Acme Hiring' } }), ctx)).toEqual({ pass: true, why: 'ats' });
  });
  it('needs a hiring signal next to the company name', () => {
    const invoice = rawMail({ from: { address: 'faturas@acme.com', name: 'Acme' }, subject: 'Sua fatura de novembro', text: 'Segue o boleto.', bulk: true });
    // Envio em massa sem sinal de vaga é boletim: não passa e não entra em "ignorados".
    expect(filterMail(invoice, ctx)).toEqual({ pass: false, ignoredCompany: null });
    expect(filterMail({ ...invoice, subject: 'Sua candidatura na Acme' }, ctx)).toEqual({ pass: true, why: 'company' });
    expect(filterMail({ ...invoice, from: { address: 'careers@acme.com', name: 'Acme' } }, ctx)).toEqual({ pass: true, why: 'company' });
    expect(filterMail({ ...invoice, text: 'Sobre a vaga de Engenheira de Software' }, ctx)).toEqual({ pass: true, why: 'company' });
  });
  it('passes a person writing straight to the owner from the company', () => {
    expect(filterMail(rawMail({ from: { address: 'joana@acme.com', name: 'Joana Lima' }, to: ['maria@example.com'], subject: 'Oi, Maria', text: 'Podemos conversar?' }), ctx))
      .toEqual({ pass: true, why: 'company' });
  });
  it('does not take a short company name from the subject', () => {
    expect(filterMail(rawMail({ from: { address: 'aviso@banco.example', name: 'Banco' }, subject: 'Nu: sua vaga no sorteio', bulk: true }), ctx))
      .toEqual({ pass: false, ignoredCompany: null });
  });
  it('ignores everything else', () => {
    expect(filterMail(rawMail({ from: { address: 'promo@loja.example', name: 'Loja' }, subject: 'Oferta de emprego dos sonhos' }), ctx)).toEqual({ pass: false, ignoredCompany: null });
  });
  it('does not count an automatic message as a person writing to the owner', () => {
    const auto = rawMail({ from: { address: 'joana@acme.com', name: 'Acme' }, subject: 'Aviso', text: 'Texto.', autoSubmitted: true });
    expect(filterMail(auto, ctx)).toEqual({ pass: false, ignoredCompany: 'Acme' });
  });
  it.each([
    'Atualização sobre suas candidaturas na Acme',
    'Your interviews with Acme',
    'Acme: novas vagas para você',
    'Acme: open positions',
  ])('takes a plural hiring word as a signal: %s', (subject) => {
    const mail = rawMail({ from: { address: 'no-reply@acme.com', name: 'Acme' }, subject, text: 'Texto.', bulk: true });
    expect(filterMail(mail, ctx)).toEqual({ pass: true, why: 'company' });
  });
  it('keeps the whole-word guard for hiring words', () => {
    const mail = rawMail({ from: { address: 'no-reply@acme.com', name: 'Acme' }, subject: 'Acme: you enrolled in our plan', text: 'Texto.', bulk: true });
    expect(filterMail(mail, ctx)).toEqual({ pass: false, ignoredCompany: null });
    expect(filterMail({ ...mail, bulk: false, autoSubmitted: true }, ctx)).toEqual({ pass: false, ignoredCompany: 'Acme' });
  });
  it('keeps a bulletin out of the ignored list, but a bulk mail with a hiring signal still passes', () => {
    const bulletin = rawMail({ from: { address: 'news@acme.com', name: 'Acme' }, subject: 'Novidades da Acme', text: 'Nosso blog.', bulk: true });
    expect(filterMail(bulletin, ctx)).toEqual({ pass: false, ignoredCompany: null });
    expect(filterMail({ ...bulletin, subject: 'Atualização da sua candidatura na Acme' }, ctx)).toEqual({ pass: true, why: 'company' });
    expect(filterMail({ ...bulletin, threadKey: 't1' }, { ...ctx, knownThreads: new Set(['t1']) })).toEqual({ pass: true, why: 'thread' });
  });
});
