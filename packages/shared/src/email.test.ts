import { describe, expect, it } from 'vitest';
import { MailAccountInputSchema } from './email';
import { AI_LAYERS } from './ai-constants';
import { DRAFT_PLACEHOLDER, EMAIL_KIND_LABELS, EMAIL_KINDS, KNOWN_FACT_LABELS, KNOWN_FACTS, emailAvailability } from './email-constants';

describe('e-mail contract', () => {
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
