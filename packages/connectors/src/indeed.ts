import { load } from 'cheerio';
import type { NormalizedJob, Region } from '@kv/shared';
import { keepValid, queriesFor, stacksWithQuery } from './normalize';
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

export function parseIndeed(html: string, ctx: ParseContext): NormalizedJob[] {
  const $ = load(html);
  const jobs = $('div.job_seen_beacon')
    .toArray()
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
  return keepValid(jobs);
}

/** Abre a página de resultados em um Chromium e devolve o HTML. Lança se o Indeed bloquear. */
export async function fetchIndeedHtml(url: string): Promise<string> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: process.env.INDEED_HEADFUL !== '1' });
  try {
    const page = await browser.newPage({ locale: 'pt-BR' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try {
      await page.waitForSelector('div.job_seen_beacon', { timeout: 20_000 });
    } catch {
      throw new Error('Indeed bloqueou o acesso ou mudou o layout');
    }
    return await page.content();
  } finally {
    await browser.close();
  }
}

export const indeed: Connector = {
  id: 'indeed',
  name: 'Indeed',
  async search(filters) {
    const out: NormalizedJob[] = [];
    for (const t of indeedTargets(filters.regions)) {
      for (const q of queriesFor(filters)) {
        const url = indeedUrl(t, q, filters.maxAgeDays);
        out.push(...parseIndeed(await fetchIndeedHtml(url), { domain: t.domain, country: t.country, query: q }));
      }
    }
    return out;
  },
};
