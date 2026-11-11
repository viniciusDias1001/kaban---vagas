import { DEFAULT_LEVER_COMPANIES, type NormalizedJob } from '@kv/shared';
import { boardList } from './greenhouse';
import { fetchJson } from './http';
import { expectList, keepValid, stacksWithQuery, toMs } from './normalize';
import type { Connector } from './types';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt: number;
  descriptionPlain?: string;
  workplaceType?: string;
  /** Código ISO de duas letras do país da vaga. */
  country?: string | null;
  categories?: { location?: string };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Usa o código de país da vaga; sem ele, tenta reconhecer o Brasil no texto da localização. */
function leverCountry(code: string | null | undefined, location: string): 'BR' | 'INT' {
  const iso = code?.trim().toUpperCase();
  if (iso) return iso === 'BR' ? 'BR' : 'INT';
  return /bra[sz]il/i.test(location) ? 'BR' : 'INT';
}

export function mapLever(postings: LeverPosting[], company: string): NormalizedJob[] {
  return keepValid(
    expectList(postings, 'lever', 'de vagas').map((j) => {
      const location = j.categories?.location ?? '';
      return {
        source: 'lever',
        externalId: j.id,
        url: j.hostedUrl,
        title: j.text,
        company: capitalize(company),
        location,
        country: leverCountry(j.country, location),
        remote: j.workplaceType === 'remote' || /remote|remoto/i.test(location),
        stacks: stacksWithQuery(j.text ?? ''),
        description: (j.descriptionPlain ?? '').trim(),
        postedAt: toMs(j.createdAt),
      };
    }),
    'lever',
  );
}

export const lever: Connector = {
  id: 'lever',
  name: 'Lever',
  async search(_filters, signal, config) {
    const companies = config?.leverCompanies?.length
      ? [...config.leverCompanies]
      : boardList('LEVER_COMPANIES', [...DEFAULT_LEVER_COMPANIES]);
    const results = await Promise.allSettled(
      companies.map(async (c) =>
        mapLever(await fetchJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${c}?mode=json`, signal), c),
      ),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<NormalizedJob[]> => r.status === 'fulfilled');
    if (ok.length === 0) {
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      const why = failed?.reason instanceof Error ? failed.reason.message : String(failed?.reason);
      throw new Error(`Lever: nenhuma empresa respondeu — ${why}`);
    }
    return ok.flatMap((r) => r.value);
  },
};
