import { describe, expect, it } from 'vitest';
import { findLeaks, NO_IDENTITY, PLACEHOLDER, scrubFixture, type ScrubIdentity } from './scrub';

const me: ScrubIdentity = {
  names: ['Ana Beatriz Souza', 'Ana Souza'],
  emails: ['ana.souza@gmail.com'],
  phones: ['11987654321'],
  extra: ['Rua das Flores, 100'],
};
const LI =
  '<a href="https://www.linkedin.com/in/ana-souza-1a2b3c/" data-urn="urn:li:fsd_profile:ACoAAB12">x</a>' +
  '<img src="https://media.licdn.com/dms/image/abc/0/1"><b>ajax:1234567890123</b>';
const DIRTY =
  `<p>Ana Beatriz Souza, ana.souza@gmail.com, rh@acme.com, (11) 98765-4321</p><input type="text" value="Ana"><textarea>oi</textarea>${LI}`;

describe('scrubFixture', () => {
  it('replaces identity strings wherever they appear', () => {
    expect(scrubFixture('<p>ANA BEATRIZ SOUZA mora na Rua das Flores, 100</p>', me)).toBe('<p>Pessoa Exemplo mora na Pessoa Exemplo</p>');
    expect(scrubFixture('<span>11 98765 4321</span>', me)).toBe('<span>+55 11 90000-0000</span>');
    expect(scrubFixture('<input type="tel" value="(11) 98765-4321">', me)).toBe('<input type="tel" value="">');
  });

  it('replaces any e-mail and any formatted phone with an empty identity, and nothing that only looks like one', () => {
    expect(scrubFixture('<a>rh@acme.com</a> <b>+1 (555) 123-4567</b>', NO_IDENTITY)).toBe('<a>pessoa@example.com</a> <b>+55 11 90000-0000</b>');
    expect(scrubFixture('<img src="logo@2x.png"> vaga 8638232002 em 2026-11-12', NO_IDENTITY)).toBe(
      '<img src="logo@2x.png"> vaga 8638232002 em 2026-11-12',
    );
  });

  it('removes member ids, profile addresses, photos and tokens', () => {
    for (const kept of ['/in/pessoa-exemplo', 'urn:li:fsd_profile:0', PLACEHOLDER.pixel]) expect(scrubFixture(LI, NO_IDENTITY)).toContain(kept);
    expect(scrubFixture(LI, NO_IDENTITY)).not.toMatch(/ana-souza|ACoAAB12|licdn\.com|ajax:1234/);
  });

  it('is idempotent and leaves nothing for findLeaks', () => {
    expect(scrubFixture(scrubFixture(DIRTY, me), me)).toBe(scrubFixture(DIRTY, me));
    expect(findLeaks(scrubFixture(DIRTY, me))).toEqual([]);
    expect([...new Set(findLeaks(DIRTY).map((l) => l.rule))].sort()).toEqual(['email', 'member_id', 'phone', 'photo', 'profile_url', 'token']);
  });

  it('touches only e-mails in script and style assets', () => {
    expect(scrubFixture('var a="suporte@site.com",b="555-123-4567";', NO_IDENTITY, 'asset')).toBe('var a="pessoa@example.com",b="555-123-4567";');
  });
});
