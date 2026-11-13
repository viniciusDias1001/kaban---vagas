import { describe, expect, it } from 'vitest';
import { APPLY_SITE_COPY, applySiteCopy } from './applySites';

describe('apply site copy', () => {
  it('has copy for the three real sites and only them', () => {
    expect(Object.keys(APPLY_SITE_COPY).sort()).toEqual(['greenhouse', 'lever', 'linkedin']);
  });
  it('warns about the LinkedIn terms of use and about the résumé reaching Lever in rehearsal', () => {
    expect(APPLY_SITE_COPY.linkedin.warning).toContain('proíbe automação');
    expect(APPLY_SITE_COPY.lever.warning).toContain('No ensaio');
  });
  it('falls back to the id for a site without copy', () => {
    expect(applySiteCopy('fake')).toEqual({ label: 'fake', login: '', how: '', warning: null });
  });
});
