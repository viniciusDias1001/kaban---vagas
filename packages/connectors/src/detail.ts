import { load } from 'cheerio';
import { fetchText, sleep } from './http';
import { openIndeedSession, type IndeedSession } from './indeed';
import { stripHtml } from './text';

/**
 * Descrição de uma vaga, buscada sob demanda para as fontes cuja busca não a entrega (LinkedIn e Indeed).
 * Valem as regras de acesso do Core: páginas públicas, sem login, sem cookies, sem disfarce; uma
 * requisição por vez em cada site, com intervalo; bloqueio ou mudança de layout vira erro claro.
 */

const LINKEDIN_DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
const PAUSE_MS = 1_500;
const INDEED_TIMEOUT_MS = 45_000;

/** Texto da descrição no HTML de `jobs-guest/jobs/api/jobPosting/<id>`. Lança se o bloco não existe. */
export function parseLinkedinDetail(html: string): string {
  const $ = load(html);
  const markup = $('.show-more-less-html__markup').first().html() ?? $('.description__text').first().html();
  const text = markup ? stripHtml(markup) : '';
  if (!text) throw new Error('linkedin: a página da vaga não tem o bloco de descrição (vaga encerrada ou layout mudou?)');
  return text;
}

/** Texto da descrição no HTML de `viewjob?jk=<id>`. Lança se o bloco não existe. */
export function parseIndeedDetail(html: string): string {
  const markup = load(html)('#jobDescriptionText').first().html();
  const text = markup ? stripHtml(markup) : '';
  if (!text) throw new Error('indeed: a página da vaga não tem o bloco de descrição (bloqueio ou layout mudou?)');
  return text;
}

export interface DetailJob {
  source: string;
  externalId: string;
  url: string;
}

export interface DetailDeps {
  fetchHtml: (url: string, signal?: AbortSignal) => Promise<string>;
  openIndeed: () => Promise<IndeedSession>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  env: Record<string, string | undefined>;
}

export type DescriptionFetcher = (job: DetailJob, signal?: AbortSignal) => Promise<string | null>;

/**
 * Devolve a descrição da vaga, ou null quando a fonte não tem busca de detalhe (as demais fontes já
 * entregam a descrição na busca). Lança quando a busca falha; quem chama segue sem descrição.
 */
export function createDescriptionFetcher(deps: Partial<DetailDeps> = {}): DescriptionFetcher {
  const {
    fetchHtml = (url: string, signal?: AbortSignal) => fetchText(url, {}, signal),
    openIndeed = () => openIndeedSession(),
    sleep: pause = sleep,
    now = Date.now,
    env = process.env,
  } = deps;

  /** Por site: uma requisição de cada vez, com PAUSE_MS entre o fim de uma e o começo da outra. */
  const lanes = new Map<string, { tail: Promise<void>; last: number }>();
  function polite<T>(site: string, work: () => Promise<T>): Promise<T> {
    const lane = lanes.get(site) ?? { tail: Promise.resolve(), last: 0 };
    lanes.set(site, lane);
    const result = lane.tail.then(async () => {
      const wait = lane.last + PAUSE_MS - now();
      if (lane.last > 0 && wait > 0) await pause(wait);
      try {
        return await work();
      } finally {
        lane.last = now();
      }
    });
    lane.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  return async (job, signal) => {
    if (job.source !== 'linkedin' && job.source !== 'indeed') return null;
    if (env.FAKE_CONNECTORS === '1') return `Descrição falsa da vaga ${job.externalId}.`;
    if (signal?.aborted) throw new Error(`${job.source}: busca da descrição cancelada`);
    if (job.source === 'linkedin') {
      if (!/^\d+$/.test(job.externalId)) throw new Error('linkedin: identificador de vaga inválido');
      return polite('linkedin', async () => parseLinkedinDetail(await fetchHtml(`${LINKEDIN_DETAIL}${job.externalId}`, signal)));
    }
    return polite('indeed', async () => {
      // Abre o Chromium do Playwright; sem navegador (container) `openIndeedSession` lança com a instrução.
      const session = await openIndeed();
      try {
        return parseIndeedDetail(await session.html(job.url, INDEED_TIMEOUT_MS, '#jobDescriptionText'));
      } finally {
        await session.close().catch(() => {});
      }
    });
  };
}

export const fetchJobDescription = createDescriptionFetcher();
