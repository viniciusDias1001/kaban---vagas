import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeQuestionText, type Question } from '@kv/shared';
import { closeDb, confirmAlias, listApplyAnswers, saveApplyAnswer, type ApplyAnswerRow, type Db } from '@kv/db';
import { createTestDb } from '@kv/db/testing';
import { bankCandidates, exactBankMatch, optionFor } from './bank';

const ctx = { company: 'Acme', jobId: 1, country: 'BR' };
let seq = 0;
const q = (label: string, options: string[] = []): Question => ({
  id: `q${++seq}`, label, help: '', kind: options.length ? 'select' : 'text', options, required: true, maxLength: null,
});
const a = (question: string, answer: string, extra: Partial<ApplyAnswerRow> = {}): ApplyAnswerRow => ({
  id: ++seq, question, normalized: normalizeQuestionText(question), key: null, answer, kind: 'text', scope: 'always',
  scopeValue: null, country: null, aliases: [], usedCount: 0, createdAt: 0, updatedAt: 0, ...extra,
});

describe('answer bank matching', () => {
  it('matches the same question by normalized text', () => {
    expect(exactBankMatch(q('Qual a sua pretensão salarial?'), [a('Qual a sua pretensao salarial', 'R$ 20.000')], ctx)?.value).toBe('R$ 20.000');
  });
  it('never matches an empty answer', () => {
    expect(exactBankMatch(q('Pronomes'), [a('Pronomes', '')], ctx)).toBeNull();
    expect(bankCandidates([a('Pronomes', '  ')], ctx)).toEqual([]);
  });
  it('respects company and job scope', () => {
    const other = a('Por que a empresa?', 'x', { scope: 'company', scopeValue: 'Outra' });
    expect(exactBankMatch(q('Por que a empresa?'), [other], ctx)).toBeNull();
    expect(exactBankMatch(q('Por que a empresa?'), [{ ...other, scopeValue: 'acme' }], ctx)).not.toBeNull();
    const job = a('Por que a vaga?', 'y', { scope: 'job', scopeValue: '2' });
    expect(exactBankMatch(q('Por que a vaga?'), [job], ctx)).toBeNull();
    expect(exactBankMatch(q('Por que a vaga?'), [{ ...job, scopeValue: '1' }], ctx)?.value).toBe('y');
  });
  it('prefers the answer for the job country and never uses another country', () => {
    const bank = [a('Precisa de visto?', 'Sim', { country: null }), a('Precisa de visto?', 'Não', { country: 'BR' })];
    expect(exactBankMatch(q('Precisa de visto?'), bank, ctx)?.value).toBe('Não');
    expect(exactBankMatch(q('Precisa de visto?'), [bank[0]!], ctx)?.value).toBe('Sim');
    expect(exactBankMatch(q('Precisa de visto?'), [a('Precisa de visto?', 'Não', { country: 'US' })], ctx)).toBeNull();
    expect(exactBankMatch(q('Precisa de visto?'), [bank[1]!], { ...ctx, country: null })).toBeNull();
  });
  it('uses a confirmed variation only with the same options', () => {
    const saved = a('Precisa de visto?', 'Não', { aliases: [{ normalized: 'do you need a visa', options: ['Yes', 'No'], value: 'No' }] });
    expect(exactBankMatch(q('Do you need a visa?', ['No', 'Yes']), [saved], ctx)?.value).toBe('No');
    expect(exactBankMatch(q('Do you need a visa?', ['Yes', 'No', 'Maybe']), [saved], ctx)).toBeNull();
    expect(exactBankMatch(q('Do you need a visa?'), [saved], ctx)).toBeNull();
  });
  it('in a list question the saved answer must be one of the options', () => {
    const bank = [a('Precisa de visto?', 'não')];
    expect(exactBankMatch(q('Precisa de visto?', ['Sim', 'Não']), bank, ctx)?.value).toBe('Não');
    expect(exactBankMatch(q('Precisa de visto?', ['Yes', 'No']), bank, ctx)).toBeNull();
  });
  it('maps a saved answer to an option without translating', () => {
    expect(optionFor('não', ['Sim', 'Não'])).toBe('Não');
    expect(optionFor('Não', ['Yes', 'No'])).toBeNull();
  });

  it('a confirmed variation of a text question returns the current answer', () => {
    const saved = a('Salary?', 'R$ 25.000', { aliases: [{ normalized: 'expected pay', options: [], value: 'R$ 20.000' }] });
    expect(exactBankMatch(q('Expected pay?'), [saved], ctx)?.value).toBe('R$ 25.000');
  });
  it('a confirmed list variation answers with the value the owner confirmed for it', () => {
    const saved = a('Precisa de visto?', 'Sim', { aliases: [{ normalized: 'do you need a visa', options: ['Yes', 'No'], value: 'No' }] });
    expect(exactBankMatch(q('Do you need a visa?', ['Yes', 'No']), [saved], ctx)?.value).toBe('No');
  });
  it('a confirmed list variation whose stored value is not among the options is not used', () => {
    const saved = a('Precisa de visto?', 'Não', { aliases: [{ normalized: 'do you need a visa', options: ['Yes', 'No'], value: 'Nope' }] });
    expect(exactBankMatch(q('Do you need a visa?', ['Yes', 'No']), [saved], ctx)).toBeNull();
    const ambiguous = a('Precisa de visto?', 'Não', { aliases: [{ normalized: 'do you need a visa', options: ['No', 'no '], value: 'no' }] });
    expect(exactBankMatch(q('Do you need a visa?', ['No', 'no ']), [ambiguous], ctx)).toBeNull();
  });
  it('optionFor keeps symbols and digits and refuses ties', () => {
    expect(optionFor('>5 years', ['<5 years', '>5 years'])).toBe('>5 years');
    expect(optionFor('R$ 2,000', ['R$ 2.000'])).toBeNull();
    expect(optionFor('5+ years', ['5 years'])).toBeNull();
    expect(optionFor('C++', ['C'])).toBeNull();
    expect(optionFor('nao', ['Sim', 'Não'])).toBe('Não');
    expect(optionFor('  NÃO ', ['Sim', 'Não'])).toBe('Não');
    expect(optionFor('Não', ['Não', 'nao'])).toBeNull();
  });
  it('a more specific scope beats the country', () => {
    const always = a('Visto?', 'Sim', { country: 'BR' });
    const job = a('Visto?', 'Não', { scope: 'job', scopeValue: '1', country: null });
    expect(exactBankMatch(q('Visto?'), [always, job], ctx)?.value).toBe('Não');
    const alwaysNull = a('Visto?', 'Talvez', { country: null });
    expect(exactBankMatch(q('Visto?'), [alwaysNull, always], ctx)?.value).toBe('Sim');
  });
  it('empty question text and empty company scope never match', () => {
    expect(exactBankMatch(q('?'), [a('!!', 'x')], ctx)).toBeNull();
    const row = a('Por quê?', 'x', { scope: 'company', scopeValue: '' });
    expect(exactBankMatch(q('Por quê?'), [row], { ...ctx, company: '' })).toBeNull();
    expect(exactBankMatch(q('Por quê?'), [row], ctx)).toBeNull();
  });
});

describe('answer bank matching against the stored answers', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(() => closeDb(db));

  it('an edited answer drops the variation the owner confirmed for the old one', async () => {
    const fields = { question: 'Precisa de patrocínio de visto?', kind: 'boolean' as const, scope: 'always' as const, scopeValue: null, country: null };
    const saved = await saveApplyAnswer(db, { ...fields, answer: 'Não' });
    await confirmAlias(db, saved.id, { normalized: normalizeQuestionText('Do you need visa sponsorship?'), options: ['Yes', 'No'], value: 'No' });
    const visa = q('Do you need visa sponsorship?', ['Yes', 'No']);
    expect(exactBankMatch(visa, await listApplyAnswers(db), ctx)?.value).toBe('No');

    await saveApplyAnswer(db, { ...fields, id: saved.id, answer: 'Sim' });
    expect(exactBankMatch(visa, await listApplyAnswers(db), ctx)).toBeNull();
    expect(exactBankMatch(q('Precisa de patrocínio de visto?', ['Sim', 'Não']), await listApplyAnswers(db), ctx)?.value).toBe('Sim');
  });
});
