import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface RemoteOkItem {
  id?: string | number;
  position?: string;
  company?: string;
  tags?: string[];
  description?: string;
  location?: string;
  url?: string;
  epoch?: number;
  date?: string;
}

export function mapRemoteOk(items: RemoteOkItem[]): NormalizedJob[] {
  return keepValid(
    items
      .filter((x) => x.position)
      .map((j) => ({
        source: 'remoteok',
        externalId: String(j.id ?? ''),
        url: j.url ?? '',
        title: j.position ?? '',
        company: j.company ?? '',
        location: j.location || 'Remote',
        country: 'INT' as const,
        remote: true,
        stacks: stacksWithQuery(`${j.position} ${(j.tags ?? []).join(' ')}`),
        description: stripHtml(j.description ?? ''),
        postedAt: toMs(j.epoch ?? j.date),
      })),
  );
}

export const remoteok: Connector = {
  id: 'remoteok',
  name: 'RemoteOK',
  async search() {
    return mapRemoteOk(await fetchJson<RemoteOkItem[]>('https://remoteok.com/api'));
  },
};
