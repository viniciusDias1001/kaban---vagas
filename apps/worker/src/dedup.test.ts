import { describe, expect, it } from 'vitest';
import { dedupHash } from './dedup';

describe('dedupHash', () => {
  it('ignores case, accents and extra spaces', () => {
    const a = dedupHash({ company: 'Acme  Tecnologia', title: 'Desenvolvedor Sênior', location: 'São Paulo' });
    const b = dedupHash({ company: 'acme tecnologia', title: 'desenvolvedor senior', location: 'sao paulo' });
    expect(a).toBe(b);
  });
  it('differs when the title differs', () => {
    const a = dedupHash({ company: 'Acme', title: 'Dev React', location: '' });
    const b = dedupHash({ company: 'Acme', title: 'Dev Node', location: '' });
    expect(a).not.toBe(b);
  });
});
