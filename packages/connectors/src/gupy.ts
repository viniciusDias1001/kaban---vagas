import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, queriesFor, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface GupyJob {
  id: number;
  name: string;
  description?: string;
  careerPageName: string;
  publishedDate: string;
  /** 'remote' | 'hybrid' | 'on-site' */
  workplaceType?: string;
  isRemoteWork?: boolean;
  city?: string;
  state?: string;
  jobUrl: string;
}

export function mapGupy(data: { data: GupyJob[] }, query?: string): NormalizedJob[] {
  return keepValid(
    data.data.map((j) => ({
      source: 'gupy',
      externalId: String(j.id),
      url: j.jobUrl,
      title: j.name,
      company: j.careerPageName,
      location: [j.city, j.state].filter(Boolean).join(', ') || 'Brasil',
      country: 'BR' as const,
      remote: j.workplaceType === 'remote' || Boolean(j.isRemoteWork),
      stacks: stacksWithQuery(j.name, query),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.publishedDate),
    })),
  );
}

export const gupy: Connector = {
  id: 'gupy',
  name: 'Gupy',
  async search(filters) {
    const out: NormalizedJob[] = [];
    for (const q of queriesFor(filters)) {
      const term = q === 'developer' ? 'desenvolvedor' : q;
      // portal.api.gupy.io/api/v1/jobs now returns 404; the portal's own same-origin endpoint works.
      const data = await fetchJson<{ data: GupyJob[] }>(
        `https://portal.gupy.io/api/job-search/jobs?jobName=${encodeURIComponent(term)}&limit=50&offset=0`,
      );
      out.push(...mapGupy(data, q));
    }
    return out;
  },
};
