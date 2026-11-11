import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { expectList, keepValid, stacksWithQuery, toMs } from './normalize';
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

interface RemotiveFeed {
  jobs: RemotiveJob[];
}

/** O feed inteiro, sem `search`: a API pública pede pouquíssimas consultas e a busca dela é frouxa. */
export const REMOTIVE_FEED_URL = 'https://remotive.com/api/remote-jobs';
export const REMOTIVE_CACHE_MS = 6 * 60 * 60 * 1000;

export function mapRemotive(data: RemotiveFeed): NormalizedJob[] {
  return keepValid(
    expectList(data.jobs, 'remotive', 'jobs').map((j) => ({
      source: 'remotive',
      externalId: String(j.id),
      url: j.url,
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || 'Remote',
      country: 'INT' as const,
      remote: true,
      stacks: stacksWithQuery(`${j.title} ${(j.tags ?? []).join(' ')}`),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.publication_date),
    })),
    'remotive',
  );
}

export interface RemotiveDeps {
  fetchFeed: () => Promise<RemotiveFeed>;
  now: () => number;
}

/**
 * Baixa o feed uma vez e o guarda na memória do processo por seis horas, para todos os perfis.
 * Os filtros do perfil não vão para a fonte: quem filtra é o `matchesFilters`, depois.
 */
export function createRemotive(deps: Partial<RemotiveDeps> = {}): Connector {
  const { fetchFeed = () => fetchJson<RemotiveFeed>(REMOTIVE_FEED_URL), now = Date.now } = deps;
  let cache: { at: number; jobs: Promise<NormalizedJob[]> } | null = null;

  return {
    id: 'remotive',
    name: 'Remotive',
    async search() {
      if (!cache || now() - cache.at >= REMOTIVE_CACHE_MS) {
        // Guarda a promessa, não o resultado: buscas simultâneas dividem a mesma requisição.
        const entry = { at: now(), jobs: fetchFeed().then(mapRemotive) };
        cache = entry;
        entry.jobs.catch(() => {
          if (cache === entry) cache = null; // falha não fica em cache
        });
      }
      const jobs = await cache.jobs;
      return jobs.map((j) => ({ ...j, stacks: [...j.stacks] }));
    },
  };
}

export const remotive = createRemotive();
