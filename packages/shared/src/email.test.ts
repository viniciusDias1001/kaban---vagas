import { describe, expect, it } from 'vitest';
import { LinkMessageSchema, MailAccountInputSchema, MailMessagesQuerySchema } from './email';
import { AI_LAYERS } from './ai-constants';
import { DRAFT_PLACEHOLDER, EMAIL_KIND_LABELS, EMAIL_KINDS, KNOWN_FACT_LABELS, KNOWN_FACTS, emailAvailability } from './email-constants';

describe('e-mail contract', () => {
  it('bounds the card id and the date filter to what the database holds', () => {
    expect(LinkMessageSchema.parse({ jobId: 2_147_483_647 })).toEqual({ jobId: 2_147_483_647 });
    expect(LinkMessageSchema.safeParse({ jobId: 2_147_483_648 }).success).toBe(false);
    expect(MailMessagesQuerySchema.parse({ since: '0' })).toEqual({ since: 0 });
    expect(MailMessagesQuerySchema.parse({ since: '8640000000000000' })).toEqual({ since: 8.64e15 });
    for (const since of ['-1', '8640000000000001', '1e20', '1.5', 'abc']) {
      expect(MailMessagesQuerySchema.safeParse({ since }).success, since).toBe(false);
    }
  });

  it('strips the spaces Google shows in an app password', () => {
    expect(MailAccountInputSchema.parse({ address: ' Maria@Example.com ', password: 'abcd efgh ijkl mnop' }))
      .toEqual({ address: 'maria@example.com', password: 'abcdefghijklmnop' });
  });
  it('rejects a password that is too short after stripping, and an invalid address', () => {
    expect(MailAccountInputSchema.safeParse({ address: 'maria@example.com', password: 'a b c' }).success).toBe(false);
    expect(MailAccountInputSchema.safeParse({ address: 'maria', password: 'abcdefghijklmnop' }).success).toBe(false);
  });
  it('finds an unfilled gap in a draft', () => {
    expect(DRAFT_PLACEHOLDER.test('Posso conversar em [[seus horários]].')).toBe(true);
    expect(DRAFT_PLACEHOLDER.test('Posso conversar na terça, às 10h.')).toBe(false);
  });
  it('finds a gap that holds a ] or was never closed, and stays non-global', () => {
    for (const text of ['Posso em [[dia ] hora]].', 'Posso em [[dia e hora.', 'Posso em [[]].', 'Posso em [[[x]]].']) {
      expect(DRAFT_PLACEHOLDER.test(text), text).toBe(true);
      expect(DRAFT_PLACEHOLDER.test(text), text).toBe(true); // sem `g`, nada de lastIndex entre chamadas
    }
    expect(DRAFT_PLACEHOLDER.test('Uma lista [1] e outra [2].')).toBe(false);
    expect(DRAFT_PLACEHOLDER.global).toBe(false);
  });
  it('only allows local hosts', () => {
    expect(emailAvailability({}).available).toBe(true);
    expect(emailAvailability({ HOST: '0.0.0.0' })).toEqual({ available: false, reason: expect.stringContaining('endereço local') });
  });
  it('keeps every kind, fact and layer labelled', () => {
    expect(Object.keys(EMAIL_KIND_LABELS)).toEqual([...EMAIL_KINDS]);
    expect(Object.keys(KNOWN_FACT_LABELS)).toEqual([...KNOWN_FACTS]);
    expect(AI_LAYERS).toContain('email');
  });
});
