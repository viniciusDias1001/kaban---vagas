import { load } from 'cheerio';
import type { NormalizedJob } from '@kv/shared';
import { keepValid, queriesFor, stacksWithQuery } from './normalize';
import type { Connector } from './types';

interface ParseContext {
  domain: string;
  country: 'BR' | 'INT';
  query: string;
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
        remote: /remot|home office/i.test(location),
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
    const targets: { domain: string; country: 'BR' | 'INT' }[] = [];
    if (filters.regions.length === 0 || filters.regions.includes('brasil')) {
      targets.push({ domain: 'br.indeed.com', country: 'BR' });
    }
    if (filters.regions.includes('exterior') || filters.regions.includes('remoto')) {
      targets.push({ domain: 'www.indeed.com', country: 'INT' });
    }
    const out: NormalizedJob[] = [];
    for (const t of targets) {
      for (const q of queriesFor(filters)) {
        const url = `https://${t.domain}/jobs?q=${encodeURIComponent(q)}&fromage=${filters.maxAgeDays}`;
        out.push(...parseIndeed(await fetchIndeedHtml(url), { ...t, query: q }));
      }
    }
    return out;
  },
};
