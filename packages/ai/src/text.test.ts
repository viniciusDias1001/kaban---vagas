import { describe, expect, it } from 'vitest';
import { buildTermIndex, foldText, hasControlChars, isKnownTerm, looseNumberId, normalizeText, novelTerms, numberIds } from './text';

const ch = (code: number) => String.fromCodePoint(code);

describe('normalizeText / foldText', () => {
  it('applies NFKC, drops zero-width and direction characters and maps every decimal digit to ASCII', () => {
    expect(normalizeText(`${ch(0xff19)}${ch(0xff10)}${ch(0xff05)}`)).toBe('90%');
    expect(normalizeText(`${ch(0x669)}${ch(0x660)} ${ch(0x966)}${ch(0x96f)}`)).toBe('90 09');
    expect(normalizeText(`4${ch(0x200b)}0${ch(0xfeff)}0${ch(0x202e)}`)).toBe('400');
    expect(normalizeText(`a${ch(0xa0)}b${ch(0x2003)}c`)).toBe('a b c');
  });

  it('folds case, accents and Cyrillic/Greek look-alikes', () => {
    expect(foldText('Fictícia AÇÃO')).toBe('ficticia acao');
    expect(foldText(`${ch(0x410)}cme G${ch(0x43e)}${ch(0x3bf)}gle`)).toBe('acme google');
  });

  it('detects control characters but not tabs and line breaks', () => {
    expect([ch(0), ch(0x1b), ch(0x7f), ch(0x85), ch(0x202e), ch(0x2066)].map(hasControlChars)).toEqual(Array(6).fill(true));
    expect(hasControlChars('linha 1\n\tlinha 2\r\n')).toBe(false);
  });
});

describe('numberIds', () => {
  it('builds the identity from value, magnitude, unit and currency', () => {
    expect(numberIds('1.200 1,200 1200')).toEqual(['1200']);
    expect(numberIds('1,5 e 1.5 e 1,50')).toEqual(['1.5']);
    expect(numberIds('12.345,67 e 12,345.67')).toEqual(['12345.67']);
    expect(numberIds('3 mil, 3k e 3.000')).toEqual(['3000']);
    expect(numberIds('R$ 1,5 milhão; 1.5 million reais; BRL 1500000')).toEqual(['BRL1500000']);
    expect(numberIds('$15 million')).toEqual(['USD15000000']);
    expect(numberIds('40%, 40 por cento, 40 percent, 40x, 40')).toEqual(['40%', '40x', '40']);
    expect(numberIds('24h e 40km')).toEqual(['24h', '40km']);
    expect(numberIds('1º lugar, 3rd place')).toEqual(['1', '3']);
  });

  it('reads dates as dates and leaves digits glued to letters to the term check', () => {
    expect(numberIds('de 2021-03 a 06/2024, em 15/03/2021')).toEqual(['d:2021-3', 'd:2024-6']);
    expect(numberIds('2021-2024')).toEqual(['2021', '2024']);
    expect(numberIds('ach_10ab7cde B2B ES6 v2 30pessoas')).toEqual([]);
  });

  it('reads simple numbers in words, in Portuguese and English', () => {
    expect(numberIds('trinta pessoas')).toEqual(['30']);
    expect(numberIds('dois mil e dezoito')).toEqual(['2018']);
    expect(numberIds('vinte e cinco, twenty-five, two hundred and five')).toEqual(['25', '205']);
    expect(numberIds('three thousand five hundred')).toEqual(['3500']);
    expect(numberIds('dois e três')).toEqual(['2', '3']);
    expect(numberIds('uma equipe, one team, por cento')).toEqual([]);
    expect(numberIds('dezenas de clientes, thousands of users, uma década')).toEqual(['q:tens', 'q:thousands', 'q:decade']);
  });

  it('has a looser identity for translations', () => {
    expect(['24h', 'd:2021-3', '40%', '40x', 'BRL1500000', 'q:tens'].map(looseNumberId)).toEqual(['24', '2021', '40%', '40x', 'BRL1500000', 'q:tens']);
  });
});

describe('terms', () => {
  const index = buildTermIndex(['Desenvolvedora Front-end', 'Node.js, TypeScript e APIs REST', 'Empresa Fictícia Ltda', 'C++ e C#']);

  it('accepts the spellings a careful reader would accept', () => {
    for (const term of ['node.js', 'nodejs', 'node', 'typescript', 'api', 'apis', 'frontend', 'front-end', 'desenvolvedor', 'desenvolvedoras', 'ficticia', 'c++', 'c#', 'ts']) {
      expect(isKnownTerm(term, index), term).toBe(true);
    }
    for (const term of ['deno', 'java', 'kubernetes', 'c', 'google']) expect(isKnownTerm(term, index), term).toBe(false);
  });

  it('extracts proper names, acronyms and technical tokens that are not in the source', () => {
    expect(novelTerms('Trabalhei no Google com AWS, OAuth2 e GraphQL em Node.js.', index, { mode: 'full' })).toEqual(['Google', 'AWS', 'OAuth2', 'GraphQL']);
    // Começo de frase e de linha não conta como nome próprio; nome conhecido conta em qualquer caixa.
    expect(novelTerms('Liderei o time.\nMigrei tudo. - Reduzi custos', index, { mode: 'full' })).toEqual([]);
    expect(novelTerms('Kubernetes no dia a dia, e docker também.', index, { mode: 'full' })).toEqual(['Kubernetes', 'docker']);
    expect(novelTerms('Em Janeiro, no Brasil, a 40% e 24h.', index, { mode: 'full' })).toEqual([]);
  });

  it('in translation mode ignores plain capitalised words and seniority words', () => {
    expect(novelTerms('Senior Developer at Initech with AWS', index, { mode: 'shapes' })).toEqual(['AWS']);
    expect(novelTerms('Senior Developer at Initech with AWS', index, { mode: 'full' })).toEqual(['Senior', 'Developer', 'Initech', 'AWS']);
  });
});
