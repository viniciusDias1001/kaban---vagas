import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { parseLinkedin } from './linkedin';

const html = readFileSync(new URL('../fixtures/linkedin.html', import.meta.url), 'utf8');

describe('parseLinkedin', () => {
  it('extracts valid jobs from the guest search html', () => {
    const jobs = parseLinkedin(html, { country: 'BR', remote: false, query: 'react' });
    expect(jobs.length).toBeGreaterThan(3);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('linkedin');
      expect(j.externalId).toMatch(/^\d+$/);
      expect(j.url).not.toContain('?');
      expect(j.stacks).toContain('react');
    }
  });

  it('returns an empty list for html without cards', () => {
    expect(parseLinkedin('<html></html>', { country: 'BR', remote: false, query: 'react' })).toEqual([]);
  });
});
