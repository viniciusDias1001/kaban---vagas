import { load } from 'cheerio';
import { fetchText, sleep } from './http';
import { openIndeedSession, type IndeedSession } from './indeed';
import { LINKEDIN_MIN_INTERVAL_MS, createLane, linkedinLane, type Lane } from './lane';
import { stripHtml } from './text';

/**
 * Descrição de uma vaga, buscada sob demanda para as fontes cuja busca não a entrega (LinkedIn e Indeed).
 * Valem as regras de acesso do Core: páginas públicas, sem login, sem cookies, sem disfarce; uma
 * requisição por vez em cada site, com intervalo; bloqueio ou mudança de layout vira erro claro.
 * No LinkedIn a faixa é a mesma da busca de vagas (`linkedinLane`): o detalhe não se sobrepõe à busca.
 */

const LINKEDIN_DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
const PAUSE_MS = LINKEDIN_MIN_INTERVAL_MS;
const INDEED_TIMEOUT_MS = 45_000;

/**
 * Tamanho máximo (em caracteres) da descrição devolvida. As camadas de IA usam no máximo 20.000; o resto
 * é folga para a tela, sem deixar uma página anômala gravar megabytes na vaga.
 */
export const MAX_DESCRIPTION_CHARS = 50_000;

function clip(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  let end = MAX_DESCRIPTION_CHARS;
  // Não corta um par substituto (emoji) ao meio.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end).trimEnd();
}

/** Botões "Show more / Show less" que vêm dentro de `.description__text` (o rótulo muda com o idioma). */
const SHOW_MORE_CONTROLS = 'button, .show-more-less-html__button, .show-more-less-button';

/** Texto da descrição no HTML de `jobs-guest/jobs/api/jobPosting/<id>`. Lança se o bloco não existe. */
export function parseLinkedinDetail(html: string): string {
  const $ = load(html);
  let markup = $('.show-more-less-html__markup').first().html();
  if (markup === null) {
    // Bloco externo: além do texto, traz os botões de expandir. Saem pelo elemento, não pelo rótulo.
    const outer = $('.description__text').first();
    outer.find(SHOW_MORE_CONTROLS).remove();
    markup = outer.html();
  }
  const text = markup ? stripHtml(markup) : '';
  if (!text) throw new Error('linkedin: a página da vaga não tem o bloco de descrição (vaga encerrada ou layout mudou?)');
  return clip(text);
}

/** Texto da descrição no HTML de `viewjob?jk=<id>`. Lança se o bloco não existe. */
export function parseIndeedDetail(html: string): string {
  const markup = load(html)('#jobDescriptionText').first().html();
  const text = markup ? stripHtml(markup) : '';
  if (!text) throw new Error('indeed: a página da vaga não tem o bloco de descrição (bloqueio ou layout mudou?)');
  return clip(text);
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
  /**
   * Faixa das requisições ao LinkedIn. Sem ela o buscador cria uma só dele (com `sleep` e `now` acima);
   * `fetchJobDescription` recebe `linkedinLane`, a mesma do conector de busca.
   */
  linkedinLane: Lane;
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
  const privateLane = () => createLane({ minIntervalMs: PAUSE_MS, sleep: pause, now });
  const lanes = { linkedin: deps.linkedinLane ?? privateLane(), indeed: privateLane() };
  const polite = <T>(site: keyof typeof lanes, work: () => Promise<T>): Promise<T> => lanes[site].run(work);

  return async (job, signal) => {
    if (job.source !== 'linkedin' && job.source !== 'indeed') return null;
    if (env.FAKE_CONNECTORS === '1') return `Descrição falsa da vaga ${job.externalId}.`;
    if (signal?.aborted) throw new Error(`${job.source}: busca da descrição cancelada`);
    if (job.source === 'linkedin') {
      if (!/^\d+$/.test(job.externalId)) throw new Error('linkedin: identificador de vaga inválido');
      return polite('linkedin', async () => {
        // A espera pela faixa pode ser longa (uma busca em curso): confere de novo antes de ir à rede.
        if (signal?.aborted) throw new Error('linkedin: busca da descrição cancelada');
        return parseLinkedinDetail(await fetchHtml(`${LINKEDIN_DETAIL}${job.externalId}`, signal));
      });
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

/** O buscador em uso pelo worker: divide a faixa do LinkedIn com o conector de busca. */
export const fetchJobDescription = createDescriptionFetcher({ linkedinLane });
