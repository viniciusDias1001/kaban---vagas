import { describe, expect, it } from 'vitest';
import type { ApplyJob } from '../types';
import { applySites, siteFor } from './index';
import { createFakeSite, fakeFixturePath } from './fake';

function job(over: Partial<ApplyJob>): ApplyJob {
  return { id: 1, source: 'fake', url: 'http://apply.fake.test/jobs/1', externalId: '1', company: 'Acme', title: 'Dev', ...over };
}

describe('site registry', () => {
  it('uses only the fake site when FAKE_APPLY_SITE=1', () => {
    expect(applySites({ FAKE_APPLY_SITE: '1' }).map((s) => s.id)).toEqual(['fake']);
    expect(applySites({}).some((s) => s.id === 'fake')).toBe(false);
    expect(applySites({}).map((s) => s.id)).toContain('greenhouse');
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
