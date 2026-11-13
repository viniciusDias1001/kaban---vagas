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
  it('opens every fake-source job on the test site, whatever host the job url names', () => {
    // A fonte falsa (FAKE_CONNECTORS=1) publica as vagas em https://example.com/jobs/fake-N; o navegador do site de
    // teste só serve FAKE_SITE_ORIGIN e corta o resto da rede, então o alvo precisa estar nele.
    const fake = createFakeSite();
    expect(fake.match(job({ url: 'https://example.com/jobs/fake-1' }))?.url).toBe('http://apply.fake.test/jobs/fake-1');
    const closed = fake.match(job({ url: 'https://example.com/jobs/fake-2?variant=closed' }));
    expect(closed?.url).toBe('http://apply.fake.test/jobs/fake-2?variant=closed');
    expect(closed?.ref.variant).toBe('closed');
    expect(fake.match(job({ url: 'http://apply.fake.test/jobs/1?variant=captcha' }))?.url).toBe('http://apply.fake.test/jobs/1?variant=captcha');
  });
  it('takes the form variant from the job url', () => {
    const fake = createFakeSite();
    expect(siteFor(job({ url: 'http://apply.fake.test/jobs/1?variant=closed' }), [fake])?.target.ref.variant).toBe('closed');
    expect(siteFor(job({}), [fake])?.target.ref.variant).toBe('form');
  });
});
