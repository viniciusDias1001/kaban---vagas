import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { openFixture } from '../testing';
import { blockSubmitClicks, captureReplay, captureSnapshot } from './capture';

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
