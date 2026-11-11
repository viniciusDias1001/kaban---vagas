import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { expectList, keepValid, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface HimalayasJob {
  guid: string;
  title: string;
  companyName: string;
  description?: string;
  pubDate: number;
  applicationLink?: string;
  locationRestrictions?: string[];
  categories?: string[];
}

export function mapHimalayas(data: { jobs: HimalayasJob[] }): NormalizedJob[] {
  return keepValid(
    expectList(data.jobs, 'himalayas', 'jobs').map((j) => ({
      source: 'himalayas',
      externalId: j.guid,
      url: j.applicationLink || j.guid,
      title: j.title,
      company: j.companyName,
      location: (j.locationRestrictions ?? []).join(', ') || 'Worldwide',
      country: 'INT' as const,
      remote: true,
      stacks: stacksWithQuery(`${j.title} ${(j.categories ?? []).join(' ')}`),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.pubDate),
    })),
    'himalayas',
  );
}

export const himalayas: Connector = {
  id: 'himalayas',
  name: 'Himalayas',
  async search() {
    const out: NormalizedJob[] = [];
    for (const offset of [0, 20, 40]) {
      const data = await fetchJson<{ jobs: HimalayasJob[] }>(`https://himalayas.app/jobs/api?limit=20&offset=${offset}`);
      out.push(...mapHimalayas(data));
    }
    return out;
  },
};
