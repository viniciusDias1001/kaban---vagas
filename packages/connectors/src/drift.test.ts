import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NormalizedJob } from '@kv/shared';
import { mapArbeitnow } from './arbeitnow';
import { mapGreenhouse } from './greenhouse';
import { mapGupy } from './gupy';
import { mapHimalayas } from './himalayas';
import { parseIndeed } from './indeed';
import { mapLever } from './lever';
import { parseLinkedin } from './linkedin';
import { keepValid } from './normalize';
import { mapRemoteOk } from './remoteok';
import { mapRemotive } from './remotive';

const text = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
/** Relê a gravação trocando o nome de um campo, como se a fonte o tivesse renomeado. */
const renamed = (name: string, from: string, to: string) => JSON.parse(text(name).replaceAll(`"${from}":`, `"${to}":`));

const valid: NormalizedJob = {
  source: 'x', externalId: '1', url: 'https://a.b/1', title: 'Dev', company: 'Acme', location: '',
  country: 'BR', remote: false, stacks: [], description: '', postedAt: null,
};

describe('keepValid', () => {
  it('drops invalid jobs while at least one is valid', () => {
    expect(keepValid([valid, { ...valid, company: '' }, { ...valid, url: 'nope' }], 'fonte')).toEqual([valid]);
  });
  it('returns an empty list for an empty input', () => {
    expect(keepValid([], 'fonte')).toEqual([]);
  });
  it('throws when there were items and none is valid, naming the source and the first issue', () => {
    const bad = [{ ...valid, company: '' }, { ...valid, company: '' }];
    expect(() => keepValid(bad, 'fonte')).toThrow(/^fonte: nenhum dos 2 itens.*formato.*company/);
  });
});

describe('shape drift is reported as an error, not as zero jobs', () => {
  it.each([
    ['remotive', () => mapRemotive(renamed('remotive.json', 'company_name', 'company')), /^remotive: .*company/],
    ['gupy', () => mapGupy(renamed('gupy.json', 'jobUrl', 'url')), /^gupy: .*url/],
    ['greenhouse', () => mapGreenhouse(renamed('greenhouse.json', 'absolute_url', 'url'), 'gitlab'), /^greenhouse: .*url/],
    ['lever', () => mapLever(renamed('lever.json', 'text', 'title'), 'palantir'), /^lever: .*title/],
    ['arbeitnow', () => mapArbeitnow(renamed('arbeitnow.json', 'company_name', 'company')), /^arbeitnow: .*company/],
    ['himalayas', () => mapHimalayas(renamed('himalayas.json', 'companyName', 'company')), /^himalayas: .*company/],
    ['remoteok', () => mapRemoteOk(renamed('remoteok.json', 'position', 'role')), /^remoteok: .*title/],
  ])('%s: a renamed item field throws', (_source, run, message) => {
    expect(run).toThrow(message);
  });

  it.each([
    ['remotive', () => mapRemotive(renamed('remotive.json', 'jobs', 'results')), /^remotive: /],
    ['gupy', () => mapGupy(renamed('gupy.json', 'data', 'items')), /^gupy: /],
    ['greenhouse', () => mapGreenhouse(renamed('greenhouse.json', 'jobs', 'postings'), 'gitlab'), /^greenhouse: /],
    ['lever', () => mapLever({ ok: false } as never, 'palantir'), /^lever: /],
    ['arbeitnow', () => mapArbeitnow(renamed('arbeitnow.json', 'data', 'items')), /^arbeitnow: /],
    ['himalayas', () => mapHimalayas(renamed('himalayas.json', 'jobs', 'results')), /^himalayas: /],
    ['remoteok', () => mapRemoteOk({ error: 'x' } as never), /^remoteok: /],
  ])('%s: a missing list throws', (_source, run, message) => {
    expect(run).toThrow(message);
  });

  it('an empty list is still a valid, empty answer', () => {
    expect(mapRemotive({ jobs: [] })).toEqual([]);
    expect(mapGupy({ data: [] })).toEqual([]);
    expect(mapGreenhouse({ jobs: [] }, 'gitlab')).toEqual([]);
    expect(mapLever([], 'palantir')).toEqual([]);
    expect(mapArbeitnow({ data: [] })).toEqual([]);
    expect(mapHimalayas({ jobs: [] })).toEqual([]);
    expect(mapRemoteOk([{ legal: 'aviso' }])).toEqual([]);
  });

  it('linkedin: cards that no longer yield a job throw', () => {
    const ctx = { country: 'BR' as const, remote: false, query: 'react' };
    const html = text('linkedin.html');
    expect(() => parseLinkedin(html.replaceAll('base-search-card__title', 'job-card__title'), ctx)).toThrow(
      /^linkedin: .*10 cartões.*title/,
    );
    expect(() => parseLinkedin(html.replaceAll('data-entity-urn', 'data-urn'), ctx)).toThrow(/^linkedin: .*externalId/);
    // um cartão ruim no meio dos bons só é descartado
    const oneBad = html.replace('base-search-card__title', 'job-card__title');
    expect(parseLinkedin(oneBad, ctx)).toHaveLength(9);
  });

  it('indeed: cards that no longer yield a job throw', () => {
    const ctx = { domain: 'br.indeed.com', country: 'BR' as const, query: 'react' };
    const html = text('indeed.html');
    expect(() => parseIndeed(html.replaceAll('data-testid="company-name"', 'data-testid="employer"'), ctx)).toThrow(
      /^indeed: .*15 cartões.*company/,
    );
    expect(() => parseIndeed(html.replaceAll('job_seen_beacon', 'job_card'), ctx)).toThrow(/^indeed: .*cartões/);
    expect(() => parseIndeed(html.replaceAll('data-jk=', 'data-job='), ctx)).toThrow(/^indeed: .*cartões/);
  });
});
