import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  updated_at?: string;
  first_published?: string;
  content?: string;
  company_name?: string;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function boardList(envName: string, defaults: string[]): string[] {
  const raw = process.env[envName];
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : defaults;
}

export function mapGreenhouse(data: { jobs: GreenhouseJob[] }, board: string): NormalizedJob[] {
  return keepValid(
    data.jobs.map((j) => {
      const location = j.location?.name ?? '';
      return {
        source: 'greenhouse',
        externalId: `${board}-${j.id}`,
        url: j.absolute_url,
        title: j.title,
        company: j.company_name || capitalize(board),
        location,
        country: /bra[sz]il/i.test(location) ? ('BR' as const) : ('INT' as const),
        remote: /remote|remoto/i.test(location),
        stacks: stacksWithQuery(j.title),
        description: stripHtml(j.content ?? ''),
        postedAt: toMs(j.first_published ?? j.updated_at),
      };
    }),
  );
}

export const greenhouse: Connector = {
  id: 'greenhouse',
  name: 'Greenhouse',
  async search() {
    const boards = boardList('GREENHOUSE_BOARDS', ['gitlab', 'stripe', 'cloudflare', 'figma']);
    const results = await Promise.allSettled(
      boards.map(async (b) =>
        mapGreenhouse(
          await fetchJson<{ jobs: GreenhouseJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true`),
          b,
        ),
      ),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<NormalizedJob[]> => r.status === 'fulfilled');
    if (ok.length === 0) throw new Error('Greenhouse: nenhum board respondeu');
    return ok.flatMap((r) => r.value);
  },
};
