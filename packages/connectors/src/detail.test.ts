import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_DESCRIPTION_CHARS, createDescriptionFetcher, parseIndeedDetail, parseLinkedinDetail } from './detail';
import type { IndeedSession } from './indeed';

const linkedinHtml = readFileSync(new URL('../fixtures/linkedin-detail.html', import.meta.url), 'utf8');
const indeedHtml = readFileSync(new URL('../fixtures/indeed-detail.html', import.meta.url), 'utf8');
const linkedinJob = { source: 'linkedin', externalId: '4489662428', url: 'https://br.linkedin.com/jobs/view/x-4489662428' };
const indeedJob = { source: 'indeed', externalId: '0123456789abcdef', url: 'https://br.indeed.com/viewjob?jk=0123456789abcdef' };

describe('parseLinkedinDetail', () => {
  it('extracts the description of the recorded guest job page as plain text', () => {
    const text = parseLinkedinDetail(linkedinHtml);
    expect(text.length).toBeGreaterThan(200);
    expect(text).not.toMatch(/<[a-z/]/i);
    expect(text).not.toMatch(/Show more|Show less/);
  });

  it('falls back to the outer block without the "Show more / Show less" button labels', () => {
    // O bloco interno (`show-more-less-html__markup`) mudou de nome: sobra o externo, que inclui os botões.
    const renamed = linkedinHtml.replaceAll('show-more-less-html__markup', 'markup-renomeado');
    expect(renamed).not.toBe(linkedinHtml);
    const text = parseLinkedinDetail(renamed);
    expect(text).toBe(parseLinkedinDetail(linkedinHtml));
    expect(text).not.toMatch(/Show more|Show less/i);

    const localized = parseLinkedinDetail(
      `<div class="description__text"><section><div class="outro"><p>Vaga de teste.</p><p>Show more of our culture on the site.</p></div>
       <button class="show-more-less-html__button" aria-label="Exibir mais">Exibir mais<icon></icon></button>
       <button class="show-more-less-html__button show-more-less-html__button--less">Exibir menos</button>
       <span class="show-more-less-button">Ver mais</span></section></div>`,
    );
    // Os rótulos somem pelo elemento (em qualquer idioma); o texto da vaga que fala "Show more" fica.
    expect(localized).toBe('Vaga de teste.\nShow more of our culture on the site.');
  });

  it('treats a fallback block with nothing but the buttons as a missing description', () => {
    const onlyButtons = '<div class="description__text"><button class="show-more-less-html__button">Show more</button></div>';
    expect(() => parseLinkedinDetail(onlyButtons)).toThrow(/^linkedin: .*descrição/);
  });

  it('clips a huge description to MAX_DESCRIPTION_CHARS without splitting a surrogate pair', () => {
    expect(MAX_DESCRIPTION_CHARS).toBe(50_000);
    const wrap = (body: string) => `<div class="show-more-less-html__markup">${body}</div>`;
    const exact = 'a'.repeat(MAX_DESCRIPTION_CHARS);
    expect(parseLinkedinDetail(wrap(exact))).toBe(exact);
    expect(parseLinkedinDetail(wrap('b'.repeat(MAX_DESCRIPTION_CHARS * 3)))).toBe('b'.repeat(MAX_DESCRIPTION_CHARS));
    // O corte cairia no meio do emoji (par substituto): ele sai inteiro, e o espaço que sobra no fim também.
    const emoji = parseLinkedinDetail(wrap(`${'c'.repeat(MAX_DESCRIPTION_CHARS - 2)} 🔑 fim`));
    expect(emoji).toBe('c'.repeat(MAX_DESCRIPTION_CHARS - 2));
    const indeed = parseIndeedDetail(`<div id="jobDescriptionText">${'d'.repeat(MAX_DESCRIPTION_CHARS + 10)}</div>`);
    expect(indeed).toHaveLength(MAX_DESCRIPTION_CHARS);
  });

  it('throws a clear error when the description block is missing', () => {
    expect(() => parseLinkedinDetail('<html><h2 class="top-card-layout__title">Dev</h2></html>')).toThrow(/^linkedin: .*descrição/);
    expect(() => parseLinkedinDetail('')).toThrow(/^linkedin: /);
  });
});

describe('parseIndeedDetail', () => {
  it('extracts the description of the job page as plain text', () => {
    const text = parseIndeedDetail(indeedHtml);
    expect(text.length).toBeGreaterThan(50);
    expect(text).not.toMatch(/<[a-z/]/i);
  });

  it('throws a clear error when the description block is missing', () => {
    expect(() => parseIndeedDetail('<html><body>Verifique se você é humano</body></html>')).toThrow(/^indeed: .*descrição/);
  });
});

describe('createDescriptionFetcher', () => {
  const noEnv = {};

  it('returns null for sources that already deliver the description', async () => {
    const fetcher = createDescriptionFetcher({ fetchHtml: async () => { throw new Error('não deveria buscar'); }, env: noEnv });
    expect(await fetcher({ source: 'gupy', externalId: '1', url: 'https://example.com/1' })).toBeNull();
  });

  it('fetches the LinkedIn guest page of the job id, without cookies or login', async () => {
    const urls: string[] = [];
    const fetcher = createDescriptionFetcher({
      fetchHtml: async (url) => {
        urls.push(url);
        return linkedinHtml;
      },
      env: noEnv,
    });
    expect(await fetcher(linkedinJob)).toBe(parseLinkedinDetail(linkedinHtml));
    expect(urls).toEqual(['https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4489662428']);
    await expect(fetcher({ ...linkedinJob, externalId: '../../feed' })).rejects.toThrow(/identificador/);
  });

  it('keeps a polite rate: one request at a time per site, with a pause between them', async () => {
    let clock = 1_000;
    let active = 0;
    let maxActive = 0;
    const sleeps: number[] = [];
    const fetcher = createDescriptionFetcher({
      fetchHtml: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        clock += 200;
        active--;
        return linkedinHtml;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      env: noEnv,
    });
    await Promise.all([fetcher(linkedinJob), fetcher(linkedinJob), fetcher(linkedinJob)]);
    expect(maxActive).toBe(1);
    expect(sleeps).toEqual([1_500, 1_500]);
  });

  it('uses the lane it is given for LinkedIn instead of a private one', async () => {
    const ran: string[] = [];
    const fetcher = createDescriptionFetcher({
      fetchHtml: async () => linkedinHtml,
      linkedinLane: {
        run: async (work) => {
          ran.push('in');
          try {
            return await work();
          } finally {
            ran.push('out');
          }
        },
      },
      sleep: async () => {
        throw new Error('a faixa recebida é quem cuida do intervalo');
      },
      env: noEnv,
    });
    expect(await fetcher(linkedinJob)).toBe(parseLinkedinDetail(linkedinHtml));
    expect(ran).toEqual(['in', 'out']);
  });

  it('propagates a failure (blocked, removed job) and keeps working afterwards', async () => {
    let n = 0;
    const fetcher = createDescriptionFetcher({
      fetchHtml: async () => {
        if (++n === 1) throw new Error('HTTP 429 em https://www.linkedin.com/...');
        return linkedinHtml;
      },
      sleep: async () => {},
      env: noEnv,
    });
    await expect(fetcher(linkedinJob)).rejects.toThrow(/HTTP 429/);
    expect(await fetcher(linkedinJob)).toContain(parseLinkedinDetail(linkedinHtml).slice(0, 30));
  });

  it('reads Indeed through a browser session, waiting for the description block, and closes it', async () => {
    const calls: unknown[] = [];
    const session: IndeedSession = {
      html: async (url, timeoutMs, waitFor) => {
        calls.push([url, timeoutMs, waitFor]);
        return indeedHtml;
      },
      close: async () => {
        calls.push('close');
      },
    };
    const fetcher = createDescriptionFetcher({ openIndeed: async () => session, env: noEnv });
    expect(await fetcher(indeedJob)).toBe(parseIndeedDetail(indeedHtml));
    expect(calls).toEqual([[indeedJob.url, 45_000, '#jobDescriptionText'], 'close']);
  });

  it('fails clearly when there is no browser for Indeed (container)', async () => {
    const fetcher = createDescriptionFetcher({
      openIndeed: async () => {
        throw new Error('Indeed precisa do Chromium do Playwright');
      },
      env: noEnv,
    });
    await expect(fetcher(indeedJob)).rejects.toThrow(/Chromium/);
  });

  it('does not start when the signal is already aborted', async () => {
    const fetcher = createDescriptionFetcher({ fetchHtml: async () => linkedinHtml, env: noEnv });
    await expect(fetcher(linkedinJob, AbortSignal.abort())).rejects.toThrow(/cancelada/);
  });

  it('answers with a deterministic text and no network under FAKE_CONNECTORS=1', async () => {
    const fetcher = createDescriptionFetcher({
      fetchHtml: async () => {
        throw new Error('não deveria buscar');
      },
      env: { FAKE_CONNECTORS: '1' },
    });
    expect(await fetcher(linkedinJob)).toBe('Descrição falsa da vaga 4489662428.');
  });
});
