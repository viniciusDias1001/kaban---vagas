import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openFixture } from '../testing';
import { ans, fakeResumePath, fixturePath, inject, job, linkSteps, watchClicks, watchWrites } from './fixtures';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function open() {
  const opened = await openFixture({
    'https://form.test/vaga': fixturePath('recording', 'page.html'),
    'https://form.test/app.js': fixturePath('recording', 'app.js'),
    'https://cdn.form.test/site.css': fixturePath('recording', 'site.css'),
    'https://form.test/proximo': fixturePath('fake', 'two-steps.html'),
  });
  close = opened.close;
  return opened.page;
}

describe('script test helpers', () => {
  it('builds plain data helpers', () => {
    expect(job({ title: 'Eng' })).toEqual({ id: 1, source: 'greenhouse', url: '', externalId: '', company: 'Acme', title: 'Eng' });
    expect(ans('q', 'x')).toMatchObject({ questionId: 'q', value: 'x', source: 'rule', category: 'identity', basis: [], bankAnswerId: null });
    expect(readFileSync(fakeResumePath(), 'latin1').startsWith('%PDF-1.4')).toBe(true);
  });

  it('linkSteps moves the page on a matching click while watchClicks still sees it', async () => {
    const page = await open();
    const clicks = await watchClicks(page);
    await page.goto('https://form.test/vaga');
    await linkSteps(page, [{ from: 'https://form.test/vaga', button: /enviar/i, to: 'https://form.test/proximo' }]);
    await page.getByRole('button', { name: 'Enviar candidatura' }).click();
    await page.waitForURL('https://form.test/proximo');
    expect(clicks).toEqual(['Enviar candidatura']);
    expect(await page.evaluate(() => (window as { enviado?: boolean }).enviado)).toBeUndefined();
  });

  it('watchWrites lists only non-GET requests, and inject puts html first in main', async () => {
    const page = await open();
    const writes = watchWrites(page);
    await page.goto('https://form.test/vaga');
    await inject(page, '<p id="novo">oi</p>');
    expect(await page.evaluate(() => document.querySelector('main')?.firstElementChild?.id)).toBe('novo');
    await page.evaluate(() => fetch('https://form.test/enviar', { method: 'POST' }).catch(() => {}));
    expect(writes).toEqual(['https://form.test/enviar']);
  });
});
