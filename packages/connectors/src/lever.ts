import type { NormalizedJob } from '@kv/shared';
import { boardList } from './greenhouse';
import { fetchJson } from './http';
import { keepValid, stacksWithQuery, toMs } from './normalize';
import type { Connector } from './types';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt: number;
  descriptionPlain?: string;
  workplaceType?: string;
  categories?: { location?: string };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function mapLever(postings: LeverPosting[], company: string): NormalizedJob[] {
  return keepValid(
    postings.map((j) => {
      const location = j.categories?.location ?? '';
      return {
        source: 'lever',
        externalId: j.id,
        url: j.hostedUrl,
        title: j.text,
        company: capitalize(company),
        location,
        country: /bra[sz]il/i.test(location) ? ('BR' as const) : ('INT' as const),
        remote: j.workplaceType === 'remote' || /remote|remoto/i.test(location),
        stacks: stacksWithQuery(j.text),
        description: (j.descriptionPlain ?? '').trim(),
        postedAt: toMs(j.createdAt),
      };
    }),
  );
}

export const lever: Connector = {
  id: 'lever',
  name: 'Lever',
  async search() {
    const companies = boardList('LEVER_COMPANIES', ['palantir', 'spotify']);
    const results = await Promise.allSettled(
      companies.map(async (c) =>
        mapLever(await fetchJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${c}?mode=json`), c),
      ),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<NormalizedJob[]> => r.status === 'fulfilled');
    if (ok.length === 0) throw new Error('Lever: nenhuma empresa respondeu');
    return ok.flatMap((r) => r.value);
  },
};
