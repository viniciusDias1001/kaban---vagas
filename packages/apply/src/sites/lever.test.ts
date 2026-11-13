import { describe, expect, it } from 'vitest';
import { job } from './fixtures';
import { leverTarget } from './lever';

const ID = '6ed76ce8-4156-4b60-b120-403538bd66cd';

describe('leverTarget', () => {
  it.each([
    `https://jobs.lever.co/palantir/${ID}`,
    `https://jobs.lever.co/palantir/${ID}/`,
    `https://jobs.lever.co/palantir/${ID}/apply`,
    `https://jobs.lever.co/palantir/${ID}?lever-source=LinkedIn`,
  ])('recognises %s', (url) => {
    expect(leverTarget(job({ source: 'lever', url, externalId: ID }))).toEqual({
      site: 'lever',
      url: `https://jobs.lever.co/palantir/${ID}/apply`,
      ref: { company: 'palantir', postingId: ID },
    });
  });

  it.each([
    'https://jobs.lever.co/palantir',
    `https://jobs.lever.co/palantir/${ID}/apply/extra`,
    `https://jobs.lever.co/palantir/extra/${ID}`,
    `https://jobs.eu.lever.co/acme/${ID}`,
    `https://palantir.com/careers/${ID}`,
    'não é url',
  ])('does not recognise %s', (url) => {
    expect(leverTarget(job({ source: 'lever', url, externalId: ID }))).toBeNull();
  });
});
