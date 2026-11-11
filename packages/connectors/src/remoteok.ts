import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { expectList, keepValid, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface RemoteOkItem {
  /** Só o primeiro item da resposta (o aviso legal) tem este campo. */
  legal?: string;
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
    expectList(items, 'remoteok', 'de vagas')
      // Só o aviso legal é pulado: um item sem `position` tem de aparecer como formato inválido.
      .filter((x) => x.legal === undefined)
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
    'remoteok',
  );
}

export const remoteok: Connector = {
  id: 'remoteok',
  name: 'RemoteOK',
  async search(_filters, signal) {
    return mapRemoteOk(await fetchJson<RemoteOkItem[]>('https://remoteok.com/api', signal));
  },
};
