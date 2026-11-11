import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema, ProfileInputSchema } from './schemas';

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
});

describe('NormalizedJobSchema', () => {
  it('rejects a job without company', () => {
    const job = {
      source: 'x', externalId: '1', url: 'https://a.b/c', title: 'Dev', company: '',
      location: '', country: 'BR', remote: false, stacks: [], description: '', postedAt: null,
    };
    expect(NormalizedJobSchema.safeParse(job).success).toBe(false);
  });
});
