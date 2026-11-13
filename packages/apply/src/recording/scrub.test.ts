import { describe, expect, it } from 'vitest';
import { findIdentityLeaks, findLeaks, NO_IDENTITY, PLACEHOLDER, scrubFixture, type ScrubIdentity } from './scrub';

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

  it('replaces a long inline image in a style block, not only in attributes', () => {
    const css = '<style>.box::after{background-image:url("data:image/png;base64,' + 'A'.repeat(300) + '")}</style>';
    expect(findLeaks(css).map((l) => l.rule)).toEqual(['photo']);
    expect(scrubFixture(css, NO_IDENTITY)).toBe('<style>.box::after{background-image:url("' + PLACEHOLDER.pixel + '")}</style>');
    expect(findLeaks(scrubFixture(css, NO_IDENTITY))).toEqual([]);
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

describe('identity check after scrubbing', () => {
  const ana: ScrubIdentity = { names: ['Ana Souza'], emails: ['ana.souza@gmail.com'], phones: ['11987654321'], extra: ['Rua das Flores, 100'] };
  it.each([
    ['a name split across tags', 'Ana <span>Souza</span>'],
    ['a name glued by tags', '<b>Ana</b><i>Souza</i>'],
    ['a newline between words', 'Ana\n  Souza'],
    ['several spaces', 'Ana     Souza'],
    ['a non-breaking space entity', 'Ana&nbsp;Souza'],
    ['a url escape', '<a href="/busca?q=Ana%20Souza">x</a>'],
    ['an accent-folded, upper-case name', 'ANA SOUZA'],
    ['one word of the name (4+ letters)', '<p>Contato: Souza</p>'],
    ['an encoded e-mail', 'ana.souza&#64;gmail.com'],
    ['an extra value split across tags', 'Rua das <em>Flores</em>, 100'],
    ['the phone digits in a url', '<a href="/p/11987654321">x</a>'],
    ['a phone with odd separators', '11 9 8765 4321'],
  ])('flags %s', (_label, text) => {
    expect(findIdentityLeaks(text, ana).length).toBeGreaterThan(0);
  });

  it('flags an accented name written with json unicode escapes', () => {
    const jose: ScrubIdentity = { names: ['José Álvares'], emails: [], phones: [], extra: [] };
    expect(findIdentityLeaks('{"name":"Jos\\u00e9 \\u00c1lvares"}', jose).length).toBeGreaterThan(0);
    expect(findLeaks('{"mail":"ana\\u0040gmail.com"}').map((l) => l.rule)).toContain('email');
  });

  it('reports nothing for clean text or an empty identity', () => {
    expect(findIdentityLeaks('<p>Pessoa Exemplo, pessoa@example.com, +55 11 90000-0000</p>', ana)).toEqual([]);
    expect(findIdentityLeaks('<p>Ana Souza</p>', NO_IDENTITY)).toEqual([]);
  });
});

describe('personal data in less common forms', () => {
  it.each([
    ['a composite urn', '<a data-urn="urn:li:fsd_profile:(ACoAAB12,xyz)">x</a>', 'member_id', /ACoAAB12/],
    ['an unformatted phone in tel:', '<a href="tel:+5511912345678">x</a>', 'phone', /5511912345678/],
    ['an unformatted international phone', '<p>+5511912345678</p>', 'phone', /5511912345678/],
    ['a percent-encoded e-mail', '<a href="mailto:ana%40gmail.com">x</a>', 'email', /ana%40/],
    ['an entity-encoded e-mail', '<p>ana&#64;gmail.com</p>', 'email', /ana&#64;/],
    ['a profile path inside an encoded url', '<a href="/redir?u=%2Fin%2Fana-souza-1a2b3c">x</a>', 'profile_url', /ana-souza/],
    ['a data-member-id attribute', '<div data-member-id="123456789"></div>', 'member_id', /123456789/],
    ['a csrf meta tag', '<meta name="csrf-token" content="Zm9vYmFyYmF6">', 'token', /Zm9vYmFy/],
    ['a csrf meta tag with reversed attributes', '<meta content="Zm9vYmFyYmF6" name="csrf-token">', 'token', /Zm9vYmFy/],
    ['a _csrf field', '{"_csrf": "abcdef123456"}', 'token', /abcdef123456/],
    ['an authenticity_token key', 'authenticity_token=abcdef123456', 'token', /abcdef123456/],
    ['a csrf key in a json response', '{"csrf_token": "abcdef123456"}', 'token', /abcdef123456/],
    ['a jwt in an attribute', '<div data-auth="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIz"></div>', 'token', /eyJhbGci/],
  ] as const)('scrubs or flags %s', (_label, dirty, rule, gone) => {
    expect(findLeaks(dirty).map((l) => l.rule)).toContain(rule);
    const clean = scrubFixture(dirty, NO_IDENTITY);
    expect(clean).not.toMatch(gone);
    expect(findLeaks(clean)).toEqual([]);
    expect(scrubFixture(clean, NO_IDENTITY)).toBe(clean);
  });

  it('scrubs the e-mail in an encoded form for assets too', () => {
    expect(scrubFixture('var a="ana%40gmail.com";', NO_IDENTITY, 'asset')).not.toMatch(/ana/);
  });
});
