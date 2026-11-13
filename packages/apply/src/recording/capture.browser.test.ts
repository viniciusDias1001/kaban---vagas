import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { openFixture } from '../testing';
import { blockSubmitClicks, blockWrites, captureReplay, captureSnapshot, hasSessionCookie } from './capture';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/recording/${name}`, import.meta.url));
const routes = {
  'https://form.test/vaga': fixture('page.html'),
  'https://form.test/app.js': fixture('app.js'),
  'https://terceiro.test/rastreio.js': fixture('app.js'),
  'https://cdn.form.test/site.css': fixture('site.css'),
};

let close: (() => Promise<void>) | undefined;
async function open(): Promise<Page> {
  const opened = await openFixture(routes);
  close = opened.close;
  return opened.page;
}
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('recording capture', () => {
  it('replay keeps the document and first-party scripts and styles, nothing else', async () => {
    const page = await open();
    const cap = await captureReplay(page, 'https://form.test/vaga');
    expect(Object.keys(cap.routes).sort()).toEqual(['https://cdn.form.test/site.css', 'https://form.test/app.js', 'https://form.test/vaga']);
    expect(Object.keys(cap.files).sort()).toEqual(Object.values(cap.routes).sort());
    expect(cap.routes['https://form.test/vaga']).toBe('document.html');
  });

  it('snapshot keeps main and dialogs, drops scripts and page chrome, and freezes what was hidden', async () => {
    const page = await open();
    await page.goto('https://form.test/vaga');
    const html = await captureSnapshot(page);
    for (const kept of ['lang="pt-BR"', 'Vaga de teste', 'role="dialog"']) expect(html).toContain(kept);
    expect(html).not.toMatch(/<script|<nav|<header|<iframe|<code|<link/i);
    expect(html).toMatch(/id="escondido"[^>]*style="[^"]*display:\s*none/);
    await expect(captureSnapshot(page, '#nao-existe')).rejects.toThrow();
  });

  it('blockSubmitClicks stops a click on the final submit button', async () => {
    const page = await open();
    await blockSubmitClicks(page);
    await page.goto('https://form.test/vaga');
    await page.getByRole('button', { name: 'Enviar candidatura' }).click();
    expect(await page.evaluate(() => (window as { enviado?: boolean }).enviado)).toBeUndefined();
  });
});

describe('recording guards', () => {
  const guardRoutes = { ...routes, 'https://form.test/forms': fixture('forms.html'), 'https://form.test/enviar': fixture('forms.html') };
  async function openForms(): Promise<Page> {
    const opened = await openFixture(guardRoutes);
    close = opened.close;
    return opened.page;
  }
  const flag = (page: Page, name: string) => page.evaluate((n) => (window as unknown as Record<string, unknown>)[n], name);

  it('blockSubmitClicks stops a click on a button inside an open shadow root', async () => {
    const page = await openForms();
    await blockSubmitClicks(page);
    await page.goto('https://form.test/forms');
    await page.locator('#sombra').click();
    expect(await flag(page, 'enviado')).toBeUndefined();
  });

  it('blockSubmitClicks stops Enter in a single-field form, requestSubmit() and a submit button with another label', async () => {
    const page = await openForms();
    await blockSubmitClicks(page);
    await page.goto('https://form.test/forms');
    await page.locator('#campo').press('Enter');
    expect(await flag(page, 'formEnviado')).toBe(false);
    await page.evaluate(() => (document.getElementById('solo') as HTMLFormElement).requestSubmit());
    expect(await flag(page, 'formEnviado')).toBe(false);
    await page.locator('#salvar').click();
    expect(await flag(page, 'formEnviado')).toBe(false);
    expect(page.url()).toBe('https://form.test/forms');
  });

  it('blockSubmitClicks fails when the guard cannot be installed on an open page', async () => {
    const broken = {
      context: () => ({
        addInitScript: async () => {},
        pages: () => [{ evaluate: async () => { throw new Error('sem acesso'); }, url: () => 'chrome://newtab/' }],
      }),
    } as unknown as Page;
    await expect(blockSubmitClicks(broken)).rejects.toThrow(/chrome:\/\/newtab/);
  });

  it('with closeUnscriptable, closes a page that cannot be scripted and still fails on a site page', async () => {
    let closed = 0;
    const page = (url: string) => ({ evaluate: async () => { throw new Error('sem acesso'); }, url: () => url, close: async () => { closed += 1; } });
    const contextWith = (pages: unknown[]) => ({ context: () => ({ addInitScript: async () => {}, pages: () => pages }) }) as unknown as Page;
    await blockSubmitClicks(contextWith([page('chrome://newtab/'), page('chrome-extension://abc/x.html')]), { closeUnscriptable: true });
    expect(closed).toBe(2);
    await expect(blockSubmitClicks(contextWith([page('https://www.linkedin.com/feed/')]), { closeUnscriptable: true })).rejects.toThrow(/linkedin/);
  });

  it('blockWrites aborts a fetch POST and a form POST made by the page', async () => {
    const page = await openForms();
    await blockWrites(page.context());
    const failed: string[] = [];
    const finished: string[] = [];
    page.on('requestfailed', (r) => { if (r.method() === 'POST') failed.push(r.url()); });
    page.on('requestfinished', (r) => { if (r.method() === 'POST') finished.push(r.url()); });
    await page.goto('https://form.test/forms');
    await page.locator('#gravar').click();
    await expect.poll(() => flag(page, 'fetchResult')).toBe('blocked');
    await page.evaluate(() => (document.getElementById('outro') as HTMLFormElement).submit());
    await expect.poll(() => failed.length).toBe(2);
    expect(finished).toEqual([]);
  });

  it('hasSessionCookie looks for a named cookie on a domain', () => {
    const cookies = [{ name: 'li_at', domain: '.linkedin.com', value: 'x' }, { name: 'other', domain: 'a.test', value: 'y' }];
    expect(hasSessionCookie(cookies, 'li_at', 'linkedin.com')).toBe(true);
    expect(hasSessionCookie(cookies, 'li_at', 'lever.co')).toBe(false);
    expect(hasSessionCookie([{ name: 'li_at', domain: '.linkedin.com', value: '' }], 'li_at', 'linkedin.com')).toBe(false);
  });
});
