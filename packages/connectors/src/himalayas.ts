import type { NormalizedJob } from '@kv/shared';
import { collectQueries } from './collect';
import { fetchJson, sleep } from './http';
import { expectList, keepValid, queriesFor, stacksWithQuery, toMs } from './normalize';
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

interface HimalayasPage {
  jobs: HimalayasJob[];
  totalCount?: number;
}

const SEARCH_URL = 'https://himalayas.app/jobs/api/search';
/** A busca devolve 20 vagas por página; duas páginas por termo cobrem as mais recentes. */
const PAGE_SIZE = 20;
const PAGES_PER_TERM = 2;
const PAUSE_MS = 500;

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
      // Sem o termo buscado: a vaga tem descrição, e é ela (com título e categorias) que decide o filtro.
      stacks: stacksWithQuery(`${j.title} ${(j.categories ?? []).join(' ')}`),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.pubDate),
    })),
    'himalayas',
  );
}

/** Busca por termo, mais recentes primeiro. A primeira página é a URL sem `page`. */
export function himalayasSearchUrl(term: string, page: number): string {
  const params = new URLSearchParams({ q: term, sort: 'recent' });
  if (page > 1) params.set('page', String(page));
  return `${SEARCH_URL}?${params}`;
}

export interface HimalayasDeps {
  fetchJson: (url: string) => Promise<HimalayasPage>;
  sleep: (ms: number) => Promise<void>;
}

export function createHimalayas(deps: Partial<HimalayasDeps> = {}): Connector {
  const { fetchJson: getPage = (url: string) => fetchJson<HimalayasPage>(url), sleep: pause = sleep } = deps;

  /** As páginas mais recentes de um termo. Só a falha da primeira página conta como falha do termo. */
  async function searchTerm(term: string): Promise<NormalizedJob[]> {
    const out: NormalizedJob[] = [];
    for (let page = 1; page <= PAGES_PER_TERM; page++) {
      let data: HimalayasPage;
      try {
        if (page > 1) await pause(PAUSE_MS);
        data = await getPage(himalayasSearchUrl(term, page));
      } catch (e) {
        if (page === 1) throw e;
        console.warn(`himalayas: página ${page} de "${term}" falhou — ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      out.push(...mapHimalayas(data));
      const seen = (page - 1) * PAGE_SIZE + data.jobs.length;
      const more = data.totalCount === undefined ? data.jobs.length >= PAGE_SIZE : data.totalCount > seen;
      if (data.jobs.length === 0 || !more) break;
    }
    return out;
  }

  return {
    id: 'himalayas',
    name: 'Himalayas',
    async search(filters) {
      const found = await collectQueries('himalayas', queriesFor(filters), searchTerm, { pause: () => pause(PAUSE_MS) });
      // A mesma vaga aparece em mais de um termo e, às vezes, em duas páginas seguidas.
      const byId = new Map(found.map((j) => [j.externalId, j] as const));
      return found.filter((j) => byId.get(j.externalId) === j);
    },
  };
}

export const himalayas = createHimalayas();
