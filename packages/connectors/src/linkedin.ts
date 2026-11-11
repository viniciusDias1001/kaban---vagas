import { load } from 'cheerio';
import type { NormalizedJob, Region } from '@kv/shared';
import { fetchText, sleep } from './http';
import { keepValid, queriesFor, stacksWithQuery, toMs } from './normalize';
import type { Connector } from './types';

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PAUSE_MS = 1500;

export interface LinkedinTarget {
  /** Valor do parâmetro `location` da busca. */
  location: string;
  /** País assumido quando o cartão não diz que a vaga é no Brasil. */
  country: 'BR' | 'INT';
  /** Busca só vagas remotas (f_WT=2); todo cartão devolvido é remoto. */
  remote: boolean;
}

interface ParseContext {
  country: 'BR' | 'INT';
  remote: boolean;
  query: string;
}

/**
 * Buscas a fazer para as regiões do perfil. Sem região (ou com `brasil`) busca o Brasil; `exterior` busca o
 * mundo todo; `remoto` busca vagas remotas no Brasil e no mundo, pois só a busca com o filtro de trabalho
 * remoto garante que o cartão é remoto.
 */
export function linkedinTargets(regions: readonly Region[]): LinkedinTarget[] {
  const targets: LinkedinTarget[] = [];
  if (regions.length === 0 || regions.includes('brasil')) targets.push({ location: 'Brazil', country: 'BR', remote: false });
  if (regions.includes('exterior')) targets.push({ location: 'Worldwide', country: 'INT', remote: false });
  if (regions.includes('remoto')) {
    targets.push({ location: 'Brazil', country: 'BR', remote: true });
    targets.push({ location: 'Worldwide', country: 'INT', remote: true });
  }
  return targets;
}

export function linkedinUrl(target: LinkedinTarget, query: string, maxAgeDays: number): string {
  const params = new URLSearchParams({
    keywords: query,
    location: target.location,
    f_TPR: `r${maxAgeDays * 86_400}`,
    start: '0',
  });
  if (target.remote) params.set('f_WT', '2');
  return `${BASE}?${params}`;
}

export function parseLinkedin(html: string, ctx: ParseContext): NormalizedJob[] {
  const $ = load(html);
  const jobs = $('li')
    .toArray()
    .map((li) => {
      const el = $(li);
      const urn = el.find('[data-entity-urn]').attr('data-entity-urn') ?? '';
      const title = el.find('.base-search-card__title').text().trim();
      const href = el.find('a.base-card__full-link').attr('href') ?? '';
      const location = el.find('.job-search-card__location').text().trim();
      return {
        source: 'linkedin',
        externalId: urn.split(':').pop() ?? '',
        url: href.split('?')[0],
        title,
        company: el.find('.base-search-card__subtitle').text().trim(),
        location,
        // O cartão manda: a busca "Worldwide" também devolve vagas no Brasil.
        country: /bra[sz]il/i.test(location) ? ('BR' as const) : ctx.country,
        remote: ctx.remote || /remot|home office/i.test(`${title} ${location}`),
        // O cartão não traz descrição: o termo buscado é a única pista da stack.
        stacks: stacksWithQuery(title, ctx.query),
        description: '',
        // `datetime` vem só com a data; toMs a trata como o fim daquele dia.
        postedAt: toMs(el.find('time').attr('datetime')),
      };
    });
  return keepValid(jobs);
}

/** Junta os resultados das buscas: a mesma vaga sai uma vez, remota se alguma busca a viu como remota. */
function mergeById(jobs: NormalizedJob[]): NormalizedJob[] {
  const byId = new Map<string, NormalizedJob>();
  for (const job of jobs) {
    const seen = byId.get(job.externalId);
    if (!seen) byId.set(job.externalId, { ...job });
    else seen.remote ||= job.remote;
  }
  return [...byId.values()];
}

export interface LinkedinDeps {
  fetchHtml: (url: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

export function createLinkedin(deps: Partial<LinkedinDeps> = {}): Connector {
  const { fetchHtml = fetchText, sleep: pause = sleep } = deps;
  return {
    id: 'linkedin',
    name: 'LinkedIn',
    async search(filters) {
      const searches = linkedinTargets(filters.regions).flatMap((target) =>
        queriesFor(filters).map((query) => ({ target, query })),
      );
      const out: NormalizedJob[] = [];
      for (const [i, { target, query }] of searches.entries()) {
        if (i > 0) await pause(PAUSE_MS);
        const html = await fetchHtml(linkedinUrl(target, query, filters.maxAgeDays));
        out.push(...parseLinkedin(html, { country: target.country, remote: target.remote, query }));
      }
      return mergeById(out);
    },
  };
}

export const linkedin = createLinkedin();
