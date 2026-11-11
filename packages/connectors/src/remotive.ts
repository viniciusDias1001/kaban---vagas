import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, queriesFor, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  tags?: string[];
  publication_date: string;
  candidate_required_location?: string;
  description?: string;
}

export function mapRemotive(data: { jobs: RemotiveJob[] }, query?: string): NormalizedJob[] {
  return keepValid(
    data.jobs.map((j) => ({
      source: 'remotive',
      externalId: String(j.id),
      url: j.url,
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || 'Remote',
      country: 'INT' as const,
      remote: true,
      stacks: stacksWithQuery(`${j.title} ${(j.tags ?? []).join(' ')}`, query),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.publication_date),
    })),
  );
}

export const remotive: Connector = {
  id: 'remotive',
  name: 'Remotive',
  async search(filters) {
    const out: NormalizedJob[] = [];
    for (const q of queriesFor(filters)) {
      const data = await fetchJson<{ jobs: RemotiveJob[] }>(
        `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}`,
      );
      out.push(...mapRemotive(data, q));
    }
    return out;
  },
};
