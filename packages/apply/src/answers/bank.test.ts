import { describe, expect, it } from 'vitest';
import { normalizeQuestionText, type Question } from '@kv/shared';
import type { ApplyAnswerRow } from '@kv/db';
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
});
