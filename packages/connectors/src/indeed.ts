import { load } from 'cheerio';
import type { NormalizedJob, Region, SearchFilters } from '@kv/shared';
import { collectQueries } from './collect';
import { sleep } from './http';
import { queriesFor, stacksWithQuery, validateJobs } from './normalize';
import type { Connector } from './types';

export interface IndeedTarget {
  domain: string;
  country: 'BR' | 'INT';
  /** Restringe a busca a vagas remotas (parâmetro de localização). */
  remoteOnly: boolean;
}

interface ParseContext {
  domain: string;
  country: 'BR' | 'INT';
  query: string;
}

const SITES = [
  { domain: 'br.indeed.com', country: 'BR', remoteLocation: 'Home Office' },
  { domain: 'www.indeed.com', country: 'INT', remoteLocation: 'Remote' },
] as const;

/**
 * Sites a consultar para as regiões do perfil. O cartão do Indeed já diz se a vaga é remota, então um site
 * consultado sem restrição (brasil → br, exterior → www) não é consultado de novo só para `remoto`.
 */
export function indeedTargets(regions: readonly Region[]): IndeedTarget[] {
  const targets: IndeedTarget[] = [];
  for (const { domain, country } of SITES) {
    const all = country === 'BR' ? regions.length === 0 || regions.includes('brasil') : regions.includes('exterior');
    if (all) targets.push({ domain, country, remoteOnly: false });
    else if (regions.includes('remoto')) targets.push({ domain, country, remoteOnly: true });
  }
  return targets;
}

export function indeedUrl(target: IndeedTarget, query: string, maxAgeDays: number): string {
  const params = new URLSearchParams({ q: query, fromage: String(maxAgeDays) });
  if (target.remoteOnly) params.set('l', SITES.find((s) => s.domain === target.domain)?.remoteLocation ?? 'Remote');
  return `https://${target.domain}/jobs?${params}`;
}

/** `data-jk` do cartão-modelo oculto que o Indeed deixa na página. */
const PLACEHOLDER_JK = 'abcdef0123456789';
const isJobKey = (jk: string) => /^[0-9a-f]{16}$/i.test(jk) && jk.toLowerCase() !== PLACEHOLDER_JK;

export function parseIndeed(html: string, ctx: ParseContext): NormalizedJob[] {
  const $ = load(html);
  // Cartões dentro de um bloco aria-hidden são modelos de layout, não vagas.
  const visible = $('div.job_seen_beacon, [data-jk]')
    .toArray()
    .filter((el) => $(el).closest('[aria-hidden="true"]').length === 0);
  const jobs = visible
    .filter((el) => $(el).is('div.job_seen_beacon'))
    .map((card) => {
      const el = $(card);
      const link = el.find('.jobTitle a').first();
      const jk = link.attr('data-jk') ?? '';
      const title = (link.find('span').first().text() || link.text()).trim();
      const location = el.find('[data-testid="text-location"]').text().trim();
      return {
        source: 'indeed',
        externalId: jk,
        url: `https://${ctx.domain}/viewjob?jk=${jk}`,
        title,
        company: el.find('[data-testid="company-name"]').text().trim(),
        location,
        country: ctx.country,
        remote: /remot|home office/i.test(`${title} ${location}`),
        // O cartão não traz descrição: o termo buscado é a única pista da stack.
        stacks: stacksWithQuery(title, ctx.query),
        description: '',
        postedAt: null,
      };
    });
  const { valid, firstIssue } = validateJobs(jobs.filter((j) => isJobKey(j.externalId)));
  // Página sem resultados não tem cartões; cartões que não rendem nenhuma vaga indicam mudança de layout.
  if (valid.length === 0 && visible.length > 0) {
    const cards = jobs.length || visible.length;
    const why = firstIssue ?? 'cartão ou identificador da vaga não encontrado';
    throw new Error(`indeed: a página tem ${cards} cartões, mas nenhum virou vaga — o layout mudou? (${why})`);
  }
  return valid;
}

/** O mínimo que usamos do Playwright; permite testar sem abrir um navegador. */
interface PageLike {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  content(): Promise<string>;
}
interface BrowserLike {
  newPage(options: { locale: string }): Promise<PageLike>;
  close(): Promise<void>;
}

/** Um navegador aberto, com uma única aba reaproveitada em todas as consultas. */
export interface IndeedSession {
  /** Abre a página de resultados e devolve o HTML, esperando no máximo `timeoutMs` ao todo. */
  html(url: string, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

const GOTO_TIMEOUT_MS = 30_000;
const CARDS_TIMEOUT_MS = 20_000;

async function launchChromium(): Promise<BrowserLike> {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: process.env.INDEED_HEADFUL !== '1' });
}

/** Abre o Chromium do Playwright, sem nenhum disfarce: se o Indeed bloquear, a busca falha. */
export async function openIndeedSession(launch: () => Promise<BrowserLike> = launchChromium): Promise<IndeedSession> {
  let browser: BrowserLike;
  try {
    browser = await launch();
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).split('\n')[0].trim();
    throw new Error(
      'Indeed precisa do Chromium do Playwright: não foi possível abrir o navegador; se ele não estiver instalado, ' +
        `rode "pnpm --filter @kv/connectors exec playwright install chromium" (${detail})`,
      { cause: e },
    );
  }
  let page: PageLike | undefined;
  return {
    async html(url, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      // Timeout 0 no Playwright significa "sem limite": nunca passamos menos de 1 ms.
      const left = (cap: number) => Math.max(1, Math.min(cap, deadline - Date.now()));
      page ??= await browser.newPage({ locale: 'pt-BR' });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left(GOTO_TIMEOUT_MS) });
      try {
        await page.waitForSelector('div.job_seen_beacon', { timeout: left(CARDS_TIMEOUT_MS) });
      } catch {
        throw new Error('Indeed bloqueou o acesso ou mudou o layout');
      }
      return page.content();
    },
    close: () => browser.close(),
  };
}

/** Abre um Chromium, baixa uma página de resultados e fecha. Usado para gravar a fixture. */
export async function fetchIndeedHtml(url: string): Promise<string> {
  const session = await openIndeedSession();
  try {
    return await session.html(url, GOTO_TIMEOUT_MS + CARDS_TIMEOUT_MS);
  } finally {
    await session.close();
  }
}

/** O worker desiste da busca em 60 s e tenta de novo: a busca inteira tem de caber nisso com folga. */
const BUDGET_MS = 45_000; // depois disso não começa outra navegação
const HARD_LIMIT_MS = 55_000; // nenhuma navegação em curso espera além disso
const PAUSE_MS = 2_000;

export interface IndeedDeps {
  open: () => Promise<IndeedSession>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function createIndeed(deps: Partial<IndeedDeps> = {}): Connector {
  const { open = () => openIndeedSession(), sleep: pause = sleep, now = Date.now } = deps;
  /** Termina quando a busca anterior fechou o navegador; nunca rejeita. */
  let previous: Promise<void> = Promise.resolve();

  async function run(filters: SearchFilters, start: number, signal?: AbortSignal): Promise<NormalizedJob[]> {
    if (signal?.aborted) throw new Error('Indeed: busca cancelada antes de começar');
    if (now() - start >= BUDGET_MS) {
      throw new Error('Indeed: outra busca ainda estava em andamento e o tempo desta acabou antes de começar');
    }
    const session = await open();
    try {
      // Termo por fora, site por dentro: se o tempo acabar, todo site já teve ao menos uma consulta.
      const searches = queriesFor(filters).flatMap((query) =>
        indeedTargets(filters.regions).map((target) => ({ target, query })),
      );
      return await collectQueries(
        'indeed',
        searches,
        async ({ target, query }) => {
          const page = await session.html(indeedUrl(target, query, filters.maxAgeDays), HARD_LIMIT_MS - (now() - start));
          return parseIndeed(page, { domain: target.domain, country: target.country, query });
        },
        { pause: () => pause(PAUSE_MS), shouldStop: () => now() - start >= BUDGET_MS || signal?.aborted === true },
      );
    } finally {
      await session.close().catch(() => {});
    }
  }

  return {
    id: 'indeed',
    name: 'Indeed',
    search(filters, signal) {
      const start = now();
      // Uma busca por vez: a nova tentativa do worker espera a anterior fechar o navegador.
      const result = previous.then(() => run(filters, start, signal));
      previous = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}

export const indeed = createIndeed();
