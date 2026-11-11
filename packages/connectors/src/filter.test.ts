import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NormalizedJob, SearchFilters } from '@kv/shared';
import { detectLevel, detectLevels, detectStacks, matchesFilters } from './filter';
import { mapRemotive } from './remotive';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const job = (over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  source: 't', externalId: '1', url: 'https://a.b/1', title: 'Desenvolvedor React Pleno', company: 'Acme',
  location: 'São Paulo', country: 'BR', remote: false, stacks: ['react'], description: '', postedAt: NOW - DAY,
  ...over,
});
const filters = (over: Partial<SearchFilters> = {}): SearchFilters => ({
  stacks: [], levels: [], maxAgeDays: 7, regions: [], ...over,
});

describe('detectLevel', () => {
  it('detects levels in pt and en', () => {
    expect(detectLevel('Desenvolvedor Sênior')).toBe('senior');
    expect(detectLevel('Sr. Backend Engineer')).toBe('senior');
    expect(detectLevel('Dev Júnior')).toBe('junior');
    expect(detectLevel('Engenheiro Pleno')).toBe('pleno');
    expect(detectLevel('[Job-32584] Mid-Level Java/React Developer, Brazil')).toBe('pleno');
    expect(detectLevel('Estagiária de Desenvolvimento')).toBe('junior');
    expect(detectLevel('Entry-Level Developer')).toBe('junior');
    expect(detectLevel('Entry Level Developer')).toBe('junior');
    expect(detectLevel('Software Engineer')).toBeNull();
  });

  it('returns the first level in reading order for dual-level titles', () => {
    expect(detectLevel('Desenvolvedor React PL/SR')).toBe('pleno');
    expect(detectLevel('Dev Júnior/Pleno')).toBe('junior');
  });

  it.each([
    'PL/SQL Developer',
    'Desenvolvedor PL-SQL',
    'Oracle PL SQL Developer',
    'Data Entry Clerk',
    'Lead Generation Manager',
    'Staff Accountant',
    'Chief of Staff',
    'Internal Tools Engineer',
    'International Sales',
    'Midwest Account Executive',
  ])('does not see a level in %s', (title) => {
    expect(detectLevel(title)).toBeNull();
  });

  it('still treats staff and lead engineering titles as senior', () => {
    expect(detectLevel('Staff Software Engineer')).toBe('senior');
    expect(detectLevel('Tech Lead .NET')).toBe('senior');
    expect(detectLevel('Lead Software Engineer')).toBe('senior');
  });
});

describe('detectLevels', () => {
  it.each([
    ['Desenvolvedor React PL/SR', ['pleno', 'senior']],
    ['Desenvolvedor(a) Mobile | React Native | Pleno a Sênior | inglês Avançado (Open)', ['pleno', 'senior']],
    ['Desenvolvimento React Pleno-Sênior', ['pleno', 'senior']],
    ['Dev Júnior/Pleno', ['junior', 'pleno']],
    ['Senior Engineer (Sr)', ['senior']],
    ['PL/SQL Developer Sr', ['senior']],
    ['Software Engineer', []],
  ])('finds every level in %s', (title, expected) => {
    expect(detectLevels(title)).toEqual(expected);
  });
});

describe('detectStacks', () => {
  it('finds known stacks without partial matches', () => {
    expect(detectStacks('Senior JavaScript and Node engineer')).toEqual(['node', 'javascript']);
  });
  it('knows c++ and common spellings', () => {
    expect(detectStacks('C++ / Golang / ReactJS / PostgreSQL')).toEqual(['react', 'go', 'postgres', 'c++']);
    expect(detectStacks('Go-to-Market Lead')).toEqual([]);
  });
});

describe('matchesFilters', () => {
  it('passes with empty filters', () => {
    expect(matchesFilters(job(), filters(), NOW)).toBe(true);
  });
  it('rejects jobs older than max age but keeps unknown dates', () => {
    expect(matchesFilters(job({ postedAt: NOW - 8 * DAY }), filters(), NOW)).toBe(false);
    expect(matchesFilters(job({ postedAt: null }), filters(), NOW)).toBe(true);
  });
  it('requires at least one stack', () => {
    expect(matchesFilters(job(), filters({ stacks: ['python'] }), NOW)).toBe(false);
    expect(matchesFilters(job(), filters({ stacks: ['python', 'react'] }), NOW)).toBe(true);
  });
  it('finds stacks in the description and through aliases', () => {
    const j = job({ title: 'Backend Developer', stacks: [], description: 'Stack: NodeJS, PostgreSQL.' });
    expect(matchesFilters(j, filters({ stacks: ['node.js'] }), NOW)).toBe(true);
    expect(matchesFilters(j, filters({ stacks: [' Postgres '] }), NOW)).toBe(true);
    expect(matchesFilters(j, filters({ stacks: ['java'] }), NOW)).toBe(false);
  });
  it('matches short terms only against title and stacks, never the description', () => {
    const prose = job({ title: 'Marketing Manager', stacks: [], description: 'Ready to go? Join our R&D team. We go fast with R.' });
    expect(matchesFilters(prose, filters({ stacks: ['go'] }), NOW)).toBe(false);
    expect(matchesFilters(prose, filters({ stacks: ['golang'] }), NOW)).toBe(false);
    expect(matchesFilters(prose, filters({ stacks: ['r'] }), NOW)).toBe(false);
    expect(matchesFilters(job({ title: 'Go-to-Market Manager', stacks: [] }), filters({ stacks: ['go'] }), NOW)).toBe(false);
    expect(matchesFilters(job({ title: 'Go Developer', stacks: [] }), filters({ stacks: ['go'] }), NOW)).toBe(true);
    expect(matchesFilters(job({ title: 'Golang Engineer', stacks: [] }), filters({ stacks: ['go'] }), NOW)).toBe(true);
    expect(matchesFilters(job({ title: 'Backend Engineer (Go)', stacks: [] }), filters({ stacks: ['go'] }), NOW)).toBe(true);
    expect(matchesFilters(job({ title: 'Backend Engineer', stacks: ['go'] }), filters({ stacks: ['go'] }), NOW)).toBe(true);
  });
  it('rejects a detected level outside the filter, keeps undetected', () => {
    expect(matchesFilters(job(), filters({ levels: ['senior'] }), NOW)).toBe(false);
    expect(matchesFilters(job({ title: 'Desenvolvedor React' }), filters({ levels: ['senior'] }), NOW)).toBe(true);
    expect(matchesFilters(job({ title: 'PL/SQL Developer' }), filters({ levels: ['senior'] }), NOW)).toBe(true);
  });
  it('accepts dual-level titles when any level is wanted', () => {
    for (const title of ['Desenvolvedor React PL/SR', 'Dev React Pleno a Sênior', 'Dev React Pleno-Sênior']) {
      expect(matchesFilters(job({ title }), filters({ levels: ['pleno'] }), NOW)).toBe(true);
      expect(matchesFilters(job({ title }), filters({ levels: ['senior'] }), NOW)).toBe(true);
      expect(matchesFilters(job({ title }), filters({ levels: ['junior'] }), NOW)).toBe(false);
    }
    expect(matchesFilters(job({ title: 'Dev Júnior/Pleno' }), filters({ levels: ['pleno'] }), NOW)).toBe(true);
  });
  it('matches regions', () => {
    expect(matchesFilters(job(), filters({ regions: ['exterior'] }), NOW)).toBe(false);
    expect(matchesFilters(job(), filters({ regions: ['brasil'] }), NOW)).toBe(true);
    expect(matchesFilters(job({ country: 'INT', remote: true }), filters({ regions: ['remoto'] }), NOW)).toBe(true);
  });
});

describe('matchesFilters on the Remotive fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/remotive.json', import.meta.url), 'utf8'));
  const f = filters({ stacks: ['react'], maxAgeDays: 30 });
  const now = Date.parse('2026-11-11T12:00:00Z');

  it('rejects jobs whose own title, tags and description never mention the stack', () => {
    const jobs = mapRemotive(fixture);
    expect(jobs).toHaveLength(5);
    for (const [i, j] of jobs.entries()) {
      const raw = fixture.jobs[i];
      const own = `${raw.title} ${raw.tags.join(' ')} ${raw.description}`;
      const mentions = /(?<![a-z0-9])react(\.?js)?(?![a-z0-9])/i.test(own);
      expect(matchesFilters(j, f, now), j.title).toBe(mentions);
    }
    // nenhuma das cinco vagas gravadas é de React
    expect(jobs.filter((j) => matchesFilters(j, f, now))).toEqual([]);
  });
});
