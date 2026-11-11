import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { expectList, keepValid, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description?: string;
  remote?: boolean;
  url: string;
  tags?: string[];
  location?: string;
  created_at: number;
}

export function mapArbeitnow(data: { data: ArbeitnowJob[] }): NormalizedJob[] {
  return keepValid(
    expectList(data.data, 'arbeitnow', 'data').map((j) => ({
      source: 'arbeitnow',
      externalId: j.slug,
      url: j.url,
      title: j.title,
      company: j.company_name,
      location: j.location ?? '',
      country: 'INT' as const,
      remote: Boolean(j.remote),
      stacks: stacksWithQuery(`${j.title} ${(j.tags ?? []).join(' ')}`),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.created_at),
    })),
    'arbeitnow',
  );
}

export const arbeitnow: Connector = {
  id: 'arbeitnow',
  name: 'Arbeitnow',
  async search() {
    return mapArbeitnow(await fetchJson<{ data: ArbeitnowJob[] }>('https://www.arbeitnow.com/api/job-board-api'));
  },
};
