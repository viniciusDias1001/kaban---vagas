import { describe, expect, it } from 'vitest';
import { canonicalTerm, decodeEntities, fold, hasTerm, stripHtml } from './text';

describe('stripHtml', () => {
  it('removes tags, decodes entities and keeps paragraph breaks', () => {
    expect(stripHtml('<p>Oi &amp; tchau</p><p>x</p>')).toBe('Oi & tchau\nx');
  });
  it('keeps text between escaped angle brackets', () => {
    expect(stripHtml('<p>experiência &lt; 2 anos e salário &gt; 5k</p>')).toBe('experiência < 2 anos e salário > 5k');
  });
  it('decodes numeric and common named entities', () => {
    expect(
      stripHtml('<p>2020 &#8211; 2024 &mdash; it&#x27;s &ldquo;ok&rdquo;&hellip; don&rsquo;t&nbsp;stop &ndash; &#39;x&#39;</p>'),
    ).toBe("2020 – 2024 — it's “ok”… don’t stop – 'x'");
  });
  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('a &bogus; b &#xZZ; c')).toBe('a &bogus; b &#xZZ; c');
  });
});

describe('fold', () => {
  it('lowercases and strips accents', () => {
    expect(fold('Sênior')).toBe('senior');
  });
});

describe('canonicalTerm', () => {
  it('trims, folds and resolves aliases', () => {
    expect(canonicalTerm('  ReactJS ')).toBe('react');
    expect(canonicalTerm('Node.js')).toBe('node');
    expect(canonicalTerm('Golang')).toBe('go');
    expect(canonicalTerm('PostgreSQL')).toBe('postgres');
    expect(canonicalTerm('Python')).toBe('python');
  });
});

describe('hasTerm', () => {
  it('matches whole terms only', () => {
    expect(hasTerm('Senior JavaScript Engineer', 'java')).toBe(false);
    expect(hasTerm('Java Developer', 'java')).toBe(true);
    expect(hasTerm('Dev C# / .NET', 'c#')).toBe(true);
    expect(hasTerm('Dev C# / .NET', '.net')).toBe(true);
  });

  it('does not let c match C# or C++', () => {
    expect(hasTerm('Dev C# / .NET', 'c')).toBe(false);
    expect(hasTerm('C++ Engineer', 'c')).toBe(false);
    expect(hasTerm('Embedded C Developer', 'c')).toBe(true);
    expect(hasTerm('C++ Engineer', 'c++')).toBe(true);
    expect(hasTerm('C# Engineer', 'c++')).toBe(false);
  });

  it.each([
    ['Senior ReactJS Developer', 'react'],
    ['React.js Developer', 'react'],
    ['React Developer', 'reactjs'],
    ['NodeJS Backend', 'node'],
    ['Node Developer', 'node.js'],
    ['Node Developer', 'nodejs'],
    ['Golang Engineer', 'go'],
    ['Go Developer', 'golang'],
    ['Backend Engineer (Go)', 'go'],
    ['ASP.NET Core Developer', '.net'],
    ['Desenvolvedor dotnet', '.net'],
    ['.NET Developer', 'dotnet'],
    ['DBA PostgreSQL', 'postgres'],
    ['Postgres DBA', 'postgresql'],
    ['VueJS Frontend', 'vue'],
    ['Vue.js Frontend', 'vuejs'],
    ['NextJS Engineer', 'next.js'],
    ['Next.js Engineer', 'nextjs'],
  ])('treats %s as mentioning %s', (text, term) => {
    expect(hasTerm(text, term)).toBe(true);
  });

  it('trims and case-folds the user term', () => {
    expect(hasTerm('React Developer', '  React ')).toBe(true);
    expect(hasTerm('React Developer', '   ')).toBe(false);
  });

  it('does not match go in go-to-market or r in R&D', () => {
    expect(hasTerm('Go-to-Market Manager', 'go')).toBe(false);
    expect(hasTerm('Go Developer', 'go')).toBe(true);
    expect(hasTerm('R&D Engineer', 'r')).toBe(false);
    expect(hasTerm('R Developer', 'r')).toBe(true);
  });
});
