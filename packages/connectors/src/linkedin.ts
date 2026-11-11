import { load } from 'cheerio';
import type { NormalizedJob } from '@kv/shared';
import { fetchText, sleep } from './http';
import { keepValid, queriesFor, stacksWithQuery, toMs } from './normalize';
import type { Connector } from './types';

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

interface ParseContext {
  country: 'BR' | 'INT';
  remote: boolean;
  query: string;
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
      return {
        source: 'linkedin',
        externalId: urn.split(':').pop() ?? '',
        url: href.split('?')[0],
        title,
        company: el.find('.base-search-card__subtitle').text().trim(),
        location: el.find('.job-search-card__location').text().trim(),
        country: ctx.country,
        remote: ctx.remote,
        stacks: stacksWithQuery(title, ctx.query),
        description: '',
        postedAt: toMs(el.find('time').attr('datetime')),
      };
    });
  return keepValid(jobs);
}

export const linkedin: Connector = {
  id: 'linkedin',
  name: 'LinkedIn',
  async search(filters) {
    const targets: { location: string; country: 'BR' | 'INT'; remote: boolean }[] = [];
    if (filters.regions.length === 0 || filters.regions.includes('brasil')) {
      targets.push({ location: 'Brazil', country: 'BR', remote: false });
    }
    if (filters.regions.includes('exterior') || filters.regions.includes('remoto')) {
      targets.push({ location: 'Worldwide', country: 'INT', remote: !filters.regions.includes('exterior') });
    }
    const out: NormalizedJob[] = [];
    for (const t of targets) {
      for (const q of queriesFor(filters)) {
        const params = new URLSearchParams({
          keywords: q,
          location: t.location,
          f_TPR: `r${filters.maxAgeDays * 86_400}`,
          start: '0',
        });
        if (t.remote) params.set('f_WT', '2');
        out.push(...parseLinkedin(await fetchText(`${BASE}?${params}`), { ...t, query: q }));
        await sleep(1500);
      }
    }
    return out;
  },
};
