import { describe, expect, it } from 'vitest';
import type { ApplyJob } from '../types';
import { applySites, siteFor } from './index';
import { createFakeSite, fakeFixturePath } from './fake';

function job(over: Partial<ApplyJob>): ApplyJob {
  return { id: 1, source: 'fake', url: 'http://apply.fake.test/jobs/1', externalId: '1', company: 'Acme', title: 'Dev', ...over };
}

describe('site registry', () => {
  it('registers the real sites in the order of the spec table, and none of them when FAKE_APPLY_SITE=1', () => {
    // linkedin goes first when its script is registered
    expect(applySites({}).map((s) => s.id)).toEqual(['greenhouse', 'lever']);
    expect(applySites({ FAKE_APPLY_SITE: '1' }).filter((s) => ['linkedin', 'greenhouse', 'lever'].includes(s.id))).toEqual([]);
  });
  it.each([
    ['greenhouse', 'https://job-boards.greenhouse.io/gitlab/jobs/8638232002', 'gitlab-8638232002', 'greenhouse'],
    ['greenhouse', 'https://stripe.com/jobs/search?gh_jid=7001234', 'stripe-7001234', 'greenhouse'],
    ['lever', 'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd', '6ed76ce8-4156-4b60-b120-403538bd66cd', 'lever'],
    // becomes 'linkedin' when the LinkedIn script is registered
    ['linkedin', 'https://br.linkedin.com/jobs/view/desenvolvedor-a-front-end-at-nelogica-4485826717', '4485826717', null],
    ['gupy', 'https://acme.gupy.io/jobs/123', '123', null],
    ['indeed', 'https://br.indeed.com/viewjob?jk=abc', 'abc', null],
    ['remotive', 'https://remotive.com/remote-jobs/software-dev/x-123', '123', null],
  ])('%s %s is claimed by at most one site', (source, url, externalId, expected) => {
    const j = job({ source, url, externalId });
    expect(applySites({}).filter((s) => s.match(j) !== null).map((s) => s.id)).toEqual(expected ? [expected] : []);
    expect(siteFor(j, applySites({}))?.site.id ?? null).toBe(expected);
  });
  it('no registered site needs login yet', () => {
    expect(applySites({}).map((s) => [s.id, s.needsLogin, s.loginUrl])).toEqual([['greenhouse', false, undefined], ['lever', false, undefined]]);
  });
  it('uses only the fake site when FAKE_APPLY_SITE=1', () => {
    expect(applySites({ FAKE_APPLY_SITE: '1' }).map((s) => s.id)).toEqual(['fake']);
    expect(applySites({}).some((s) => s.id === 'fake')).toBe(false);
    expect(applySites({}).map((s) => s.id)).toContain('greenhouse');
    expect(applySites({}).map((s) => s.id)).toContain('lever');
  });
  it('matches a job to the first site that accepts it', () => {
    const fake = createFakeSite();
    expect(siteFor(job({ source: 'fake' }), [fake])?.target.site).toBe('fake');
    expect(siteFor(job({ source: 'remotive' }), [fake])).toBeNull();
  });
  it('normalizes an unknown variant in the target url', () => {
    const t = createFakeSite().match(job({ url: 'http://apply.fake.test/jobs/1?variant=../../x' }));
    expect(t?.ref.variant).toBe('form');
    expect(new URL(t!.url).searchParams.get('variant')).toBe('form');
    expect(() => fakeFixturePath('../../x')).toThrow();
  });
  it('takes the form variant from the job url', () => {
    const fake = createFakeSite();
    expect(siteFor(job({ url: 'http://apply.fake.test/jobs/1?variant=closed' }), [fake])?.target.ref.variant).toBe('closed');
    expect(siteFor(job({}), [fake])?.target.ref.variant).toBe('form');
  });
});
