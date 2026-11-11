import { describe, expect, it } from 'vitest';
import type { Column, JobDto, JobListItemDto } from '@kv/shared/client';
import {
  applyMove, countJobs, filterByColumn, groupByColumn, matchesFilter, mergeServerJob, normalizeText, remainingAfter,
} from './board';

const job = (id: number, over: Partial<JobListItemDto> = {}): JobListItemDto => ({
  id, source: 'gupy', externalId: String(id), url: `https://example.com/${id}`, title: `Vaga ${id}`, company: 'Acme',
  location: 'SP', country: 'BR', remote: false, level: null, stacks: [], postedAt: null, discoveredAt: 1,
  profileId: null, column: 'descobertas', position: id, appliedBy: null, needsHuman: false, needsHumanReason: null,
  notes: '', ...over,
});

describe('normalizeText / matchesFilter', () => {
  it('ignores case and accents in both directions', () => {
    expect(normalizeText('  Açaí Labs ')).toBe('acai labs');
    const j = job(1, { title: 'Engenheira de Software Sênior', company: 'São João Tech' });
    expect(matchesFilter(j, normalizeText('senior'))).toBe(true);
    expect(matchesFilter(j, normalizeText('SÊNIOR'))).toBe(true);
    expect(matchesFilter(j, normalizeText('sao joao'))).toBe(true);
    expect(matchesFilter(j, normalizeText('python'))).toBe(false);
  });
  it('matches everything with an empty filter', () => {
    expect(matchesFilter(job(1), '')).toBe(true);
  });
});

describe('groupByColumn', () => {
  it('orders each column by position, then id', () => {
    const grouped = groupByColumn([job(3, { position: 1 }), job(2, { position: 1 }), job(1, { position: 5 }), job(4, { column: 'oferta' })]);
    expect(grouped.descobertas.map((j) => j.id)).toEqual([2, 3, 1]);
    expect(grouped.oferta.map((j) => j.id)).toEqual([4]);
    expect(grouped.arquivada).toEqual([]);
  });
  it('keeps the array of a column whose cards did not change', () => {
    const a = job(1);
    const b = job(2, { column: 'aplicada' });
    const first = groupByColumn([a, b]);
    const second = groupByColumn([a, { ...b, title: 'mudou' }], first);
    expect(second.descobertas).toBe(first.descobertas);
    expect(second.arquivada).toBe(first.arquivada);
    expect(second.aplicada).not.toBe(first.aplicada);
  });
  it('ignores a job in a column this version does not know', () => {
    expect(countJobs(groupByColumn([job(1, { column: 'nova' as Column })]))).toBe(0);
  });
});

describe('filterByColumn', () => {
  const grouped = groupByColumn([
    job(1, { title: 'React' }), job(2, { title: 'Python' }), job(3, { title: 'React Native', column: 'aplicada' }),
  ]);
  it('returns the same object without a filter', () => {
    expect(filterByColumn(grouped, '')).toBe(grouped);
  });
  it('keeps the real order and counts the matches', () => {
    const filtered = filterByColumn(grouped, 'react');
    expect(filtered.descobertas.map((j) => j.id)).toEqual([1]);
    expect(filtered.aplicada.map((j) => j.id)).toEqual([3]);
    expect(countJobs(filtered)).toBe(2);
  });
  it('reuses the previous filtered array when the matches are the same', () => {
    const first = filterByColumn(grouped, 'react');
    const second = filterByColumn(grouped, 'reac', first);
    expect(second.descobertas).toBe(first.descobertas);
  });
});

describe('applyMove / mergeServerJob', () => {
  const list = [job(1), job(2), job(3)];
  it('changes only the moved job and keeps the identity of the others', () => {
    const next = applyMove(list, 2, 'aplicada', 7.5);
    expect(next[1]).toMatchObject({ id: 2, column: 'aplicada', position: 7.5 });
    expect(next[0]).toBe(list[0]);
    expect(next[2]).toBe(list[2]);
  });
  it('takes the final position from the server and never stores the description in the list', () => {
    const server = { ...job(2), column: 'aplicada', position: 4, appliedBy: 'humano', description: 'longa', dedupHash: 'h' } as JobDto;
    const next = mergeServerJob(list, server);
    expect(next[1]).toMatchObject({ id: 2, column: 'aplicada', position: 4, appliedBy: 'humano' });
    expect(next[1]).not.toHaveProperty('description');
    expect(next[1]).not.toHaveProperty('dedupHash');
    expect(next[0]).toBe(list[0]);
  });
  it('rolls back with the previous column and position', () => {
    const moved = applyMove(list, 2, 'oferta', 99);
    expect(applyMove(moved, 2, list[1].column, list[1].position)[1]).toEqual(list[1]);
  });
});

describe('remainingAfter', () => {
  it('never goes below zero', () => {
    expect(remainingAfter(700, 60)).toBe(640);
    expect(remainingAfter(40, 60)).toBe(0);
  });
});
