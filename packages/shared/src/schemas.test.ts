import { describe, expect, it } from 'vitest';
import { JobPatchSchema, NormalizedJobSchema, ProfileInputSchema, ProfilePatchSchema } from './schemas';

describe('ProfileInputSchema', () => {
  const valid = {
    name: 'React Pleno',
    stacks: ['react'],
    levels: ['pleno'],
    maxAgeDays: 7,
    regions: ['remoto'],
    sources: ['gupy'],
  };

  it('accepts a valid profile and defaults active to true', () => {
    expect(ProfileInputSchema.parse(valid).active).toBe(true);
  });

  it('rejects an unsupported max age', () => {
    expect(() => ProfileInputSchema.parse({ ...valid, maxAgeDays: 5 })).toThrow();
  });

  it('rejects a profile without sources', () => {
    expect(() => ProfileInputSchema.parse({ ...valid, sources: [] })).toThrow();
  });

  it('caps the name at 80 chars, each stack at 40 chars and the list at 20 stacks', () => {
    const ok = (over: object) => ProfileInputSchema.safeParse({ ...valid, ...over }).success;
    expect(ok({ name: 'n'.repeat(80) })).toBe(true);
    expect(ok({ name: 'n'.repeat(81) })).toBe(false);
    expect(ok({ stacks: ['s'.repeat(40)] })).toBe(true);
    expect(ok({ stacks: ['s'.repeat(41)] })).toBe(false);
    expect(ok({ stacks: Array.from({ length: 20 }, (_, i) => `s${i}`) })).toBe(true);
    expect(ok({ stacks: Array.from({ length: 21 }, (_, i) => `s${i}`) })).toBe(false);
  });

  it('rejects NUL characters in name, stacks and sources (create and patch)', () => {
    for (const over of [{ name: 'a\u0000b' }, { stacks: ['re\u0000act'] }, { sources: ['gu\u0000py'] }]) {
      expect(ProfileInputSchema.safeParse({ ...valid, ...over }).success).toBe(false);
      expect(ProfilePatchSchema.safeParse(over).success).toBe(false);
    }
  });
});

describe('JobPatchSchema', () => {
  it('caps notes at 20 000 chars and rejects NUL', () => {
    expect(JobPatchSchema.safeParse({ notes: 'n'.repeat(20_000) }).success).toBe(true);
    expect(JobPatchSchema.safeParse({ notes: 'n'.repeat(20_001) }).success).toBe(false);
    expect(JobPatchSchema.safeParse({ notes: 'a\u0000' }).success).toBe(false);
  });
});

describe('NormalizedJobSchema', () => {
  const base = {
    source: 'x', externalId: '1', url: 'https://a.b/c', title: 'Dev', company: 'Acme',
    location: '', country: 'BR', remote: false, stacks: [], description: '', postedAt: null,
  };

  it('accepts http and https urls only', () => {
    expect(NormalizedJobSchema.safeParse(base).success).toBe(true);
    expect(NormalizedJobSchema.safeParse({ ...base, url: 'http://a.b/c' }).success).toBe(true);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://a.b/c', 'mailto:a@b.c']) {
      expect(NormalizedJobSchema.safeParse({ ...base, url }).success, url).toBe(false);
    }
  });

  it('rejects a job without company', () => {
    const job = {
      source: 'x', externalId: '1', url: 'https://a.b/c', title: 'Dev', company: '',
      location: '', country: 'BR', remote: false, stacks: [], description: '', postedAt: null,
    };
    expect(NormalizedJobSchema.safeParse(job).success).toBe(false);
  });
});
