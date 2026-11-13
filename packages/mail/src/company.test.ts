import { describe, expect, it } from 'vitest';
import { companyInDomain, companyInHeaders, companyInText, domainOf, normalizeCompany } from './company';
import { isAtsAddress } from './ats';

describe('company matching', () => {
  it.each([['Acme Ltda.', 'acme'], ['Globex S.A.', 'globex'], ['Café Órbita Inc', 'cafe orbita']])('normalizes %s', (a, b) => expect(normalizeCompany(a)).toBe(b));
  it('matches whole words only', () => {
    expect(companyInText('Stone', 'Vaga na Stone Pagamentos')).toBe(true);
    expect(companyInText('Stone', 'Limestone quarry tour')).toBe(false);
  });
  it('matches a short name only by domain', () => {
    expect(companyInText('Nu', 'Sua fatura do Nu chegou')).toBe(false);
    expect(companyInDomain('Nu', 'nu.com.br')).toBe(true);
    expect(companyInDomain('Acme', 'mail.acme.com')).toBe(true);
    expect(companyInDomain('Acme', 'acmecorp.com')).toBe(false);
  });
  it('ignores the public suffix and the accents', () => {
    expect(companyInDomain('Com', 'acme.com')).toBe(false);
    expect(companyInDomain('Café Órbita', 'cafeorbita.co.uk')).toBe(true);
    expect(companyInText('Café Órbita', 'Olá da CAFE ORBITA!')).toBe(true);
  });
  it('reads the domain and the headers', () => {
    expect(domainOf('Joana@Mail.Acme.com')).toBe('mail.acme.com');
    expect(companyInHeaders('Acme', { from: { address: 'x@acme.com', name: 'X' }, subject: 'Oi' })).toBe(true);
    expect(companyInHeaders('Acme', { from: { address: 'x@y.com', name: 'X' }, subject: 'Acme: oi' })).toBe(true);
    expect(companyInHeaders('Acme', { from: { address: 'x@y.com', name: 'X' }, subject: 'Oi' })).toBe(false);
  });
});

describe('ats', () => {
  it('matches the domain and its subdomains only', () => {
    expect(isAtsAddress('a@us.greenhouse-mail.io')).toBe(true);
    expect(isAtsAddress('a@gupy.io')).toBe(true);
    expect(isAtsAddress('a@notgupy.io')).toBe(false);
    expect(isAtsAddress('a@lever.co', ['gupy.io'])).toBe(false);
  });
});
