import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Question } from '@kv/shared';
import { SiteLayoutError, SubmitRejectedError } from '../types';
import { openFixture } from '../testing';
import { ans, fakeResumePath, fixturePath, inject, job, linkSteps, replayRoutes, watchClicks, watchWrites } from './fixtures';
import { createGreenhouseSite, greenhouseTarget, mapGreenhouseQuestions } from './greenhouse';

const api = JSON.parse(readFileSync(fixturePath('greenhouse', 'job.json'), 'utf8'));
// A página gravada fica só na máquina de quem a gravou (pasta ignorada pelo git): sem ela, este arquivo é pulado.
const recorded = existsSync(fixturePath('greenhouse', 'form/routes.json'));
const routes = recorded ? replayRoutes('greenhouse', 'form') : {};
const formUrl = Object.keys(routes).find((u) => u.includes('/embed/job_app')) ?? 'https://job-boards.greenhouse.io/embed/job_app';
const DONE = formUrl.replace('/embed/job_app', '/embed/job_app/confirmation');
const target = greenhouseTarget(job({ url: formUrl }))!;
const site = createGreenhouseSite({ fetchJob: async () => api, stepMs: 5_000, submitMs: 1_500 });
const mapped = mapGreenhouseQuestions(api);
const text = mapped.find((q) => q.kind === 'text' && q.required)!;
const select = mapped.find((q) => q.kind === 'select')!;
const files = { resumePath: fakeResumePath() };
const BADGE = '<textarea name="g-recaptcha-response" style="display:none"></textarea><iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?size=invisible" width="256" height="60"></iframe>';
const CHALLENGE = '<iframe id="desafio" src="https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x" width="400" height="580" style="position:fixed;top:0;left:0"></iframe>';

let page: Page;
let close: () => Promise<void>;
const uploads = new WeakMap<Page, string[]>();

beforeEach(async () => {
  ({ page, close } = await openFixture({ ...routes, [DONE]: fixturePath('greenhouse', 'confirmation.synthetic.html') }));
  // O formulário envia o arquivo direto ao S3 (que a rede cortada recusaria) e só mostra o nome depois da resposta.
  // O teste atende esse POST com uma resposta local e anota o nome de cada arquivo enviado.
  const names: string[] = [];
  uploads.set(page, names);
  await page.route(/s3\.amazonaws\.com/, async (route) => {
    const body = route.request().postData() ?? '';
    for (const m of body.matchAll(/filename="([^"]+)"/g)) names.push(m[1]);
    await route.fulfill({
      status: 201,
      contentType: 'application/xml',
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' },
      body: '<PostResponse><Key>tmp/cv.pdf</Key></PostResponse>',
    });
  });
});
afterEach(async () => { await close?.(); });

/** O texto que o combobox da pergunta mostra. */
async function shownValue(p: Page, q: Question): Promise<string> {
  const container = p.locator(`[id="${q.id}"]`).locator('xpath=ancestor::div[contains(@class,"select__container")][1]');
  const shown = container.locator('.select__single-value, .select__multi-value__label');
  return (await shown.allTextContents()).join(', ');
}

/** O nome de arquivo que o formulário enviou, um por campo de arquivo preenchido. */
async function uploadedNames(p: Page): Promise<string[]> {
  await p.waitForTimeout(700);
  return [...(uploads.get(p) ?? [])];
}

describe.skipIf(!recorded)('greenhouse site (needs the recorded form: run pnpm apply:fixtures)', () => {
  it('opens the embed form and reads the questions the API publishes', async () => {
    expect(await site.open(page, target)).toEqual({ kind: 'form' });
    expect(await site.readStep(page)).toMatchObject({ isLast: true });
    expect((await site.readStep(page)).questions.slice(0, mapped.length)).toEqual(mapped);
  });

  it('reports a closed job without opening the page, and a load failure as a plain error', async () => {
    expect(await createGreenhouseSite({ fetchJob: async () => null }).open(page, target)).toEqual({ kind: 'unavailable', reason: 'closed' });
    expect(page.url()).toBe('about:blank');
    await expect(site.open(page, { ...target, url: target.url.replace(/token=\d+/, 'token=1') })).rejects.not.toBeInstanceOf(SiteLayoutError);
  });

  it('is a layout error when a required API question has no control on the page', async () => {
    const extra = { label: 'Pergunta que a página não tem', required: true, fields: [{ name: 'question_0', type: 'input_text', values: [] }] };
    const drifted = createGreenhouseSite({ fetchJob: async () => ({ ...api, questions: [...api.questions, extra] }), stepMs: 5_000 });
    await drifted.open(page, target);
    await expect(drifted.readStep(page)).rejects.toBeInstanceOf(SiteLayoutError);
  });

  it('reads a required consent checkbox that belongs to no API field', async () => {
    await site.open(page, target);
    await inject(page, '<label><input type="checkbox" id="data_consent" required> I agree to the processing of my data</label>');
    const { questions } = await site.readStep(page);
    expect(questions.slice(mapped.length)).toEqual([
      { id: 'data_consent', label: 'I agree to the processing of my data', help: '', kind: 'boolean', options: [], required: true, maxLength: null },
    ]);
    await site.fillStep(page, [ans('data_consent', true)], files);
    expect(await page.locator('#data_consent').isChecked()).toBe(true);
    await site.fillStep(page, [ans('data_consent', false)], files);
    expect(await page.locator('#data_consent').isChecked()).toBe(false);
  });

  it('fills text, picks the exact option, uploads the résumé only into the résumé field, and empties on null', async () => {
    await site.open(page, target);
    await site.fillStep(page, [ans(text.id, 'Ana'), ans(select.id, select.options[1]), ans('resume', 'cv.pdf'), ans('cover_letter', 'cv.pdf'), ans('question_inexistente', 'x')], files);
    expect(await page.getByLabel(text.label, { exact: true }).inputValue()).toBe('Ana');
    expect(await shownValue(page, select)).toBe(select.options[1]);
    expect(await uploadedNames(page)).toEqual([basename(files.resumePath)]);
    await site.fillStep(page, [ans(text.id, null)], files);
    expect(await page.getByLabel(text.label, { exact: true }).inputValue()).toBe('');
  });

  it('a field the page will not let it fill is a layout error, not a passing error (C-4)', async () => {
    await site.open(page, target);
    page.setDefaultTimeout(800);
    await page.getByLabel(text.label, { exact: true }).evaluate((el) => { (el as HTMLInputElement).disabled = true; });
    await expect(site.fillStep(page, [ans(text.id, 'Ana')], files)).rejects.toBeInstanceOf(SiteLayoutError);
  });

  it('empties a chosen option on null', async () => {
    await site.open(page, target);
    await site.fillStep(page, [ans(select.id, select.options[0])], files);
    expect(await shownValue(page, select)).toBe(select.options[0]);
    await site.fillStep(page, [ans(select.id, null)], files);
    expect(await shownValue(page, select)).toBe('');
  });

  it('never picks a look-alike option: an answer outside the list is a layout error', async () => {
    await site.open(page, target);
    await expect(site.fillStep(page, [ans(select.id, `${select.options[0]} (talvez)`)], files)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(await shownValue(page, select)).toBe('');
  });

  // O job.json gravado (gitlab 8704363002) não tem pergunta multi_value_multi_select: este teste fica pulado.
  const multi = mapped.find((q) => q.kind === 'multiselect');
  it.skipIf(!multi)('ticks both options of a multiselect', async () => {
    await site.open(page, target);
    await site.fillStep(page, [ans(multi!.id, multi!.options.slice(0, 2))], files);
    expect(await shownValue(page, multi!)).toBe(multi!.options.slice(0, 2).join(', '));
  });

  it('does not call a loaded captcha a gate; a challenge or a code prompt on screen is one', async () => {
    await site.open(page, target);
    await inject(page, BADGE);
    expect(await site.humanGate(page)).toBeNull();
    await inject(page, CHALLENGE);
    expect(await site.humanGate(page)).toBe('captcha');
    await page.evaluate(() => document.getElementById('desafio')?.remove());
    expect(await site.humanGate(page)).toBeNull();
    await inject(page, '<label>Verification code <input type="text"></label>');
    expect(await site.humanGate(page)).toBe('verification_code');
  });

  it('never advances and never reports success without a confirmation', async () => {
    const clicks = await watchClicks(page);
    await site.open(page, target);
    await expect(site.next(page)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(clicks).toEqual([]);
    await expect(site.submit(page)).rejects.toBeInstanceOf(Error);
    await page.waitForTimeout(300);
    expect(clicks.filter((c) => /submit application/i.test(c))).toHaveLength(1);
  });

  it('returns the confirmation text, and does not click again once it is on screen', async () => {
    const clicks = await watchClicks(page);
    await linkSteps(page, [{ from: formUrl, button: /submit application/i, to: DONE }]);
    await site.open(page, target);
    expect(await site.submit(page)).toEqual({ confirmation: 'Thank you for applying.' });
    expect(await site.submit(page)).toEqual({ confirmation: 'Thank you for applying.' });
    expect(clicks).toHaveLength(1);
  });

  it('discards without sending and without leaving a draft', async () => {
    const writes = watchWrites(page);
    await site.open(page, target);
    await page.evaluate(() => localStorage.setItem('rascunho', 'x'));
    const before = writes.length;
    await site.discard(page);
    expect(page.url()).toBe('about:blank');
    expect(writes.length).toBe(before);
    await page.goto(formUrl);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  });

  it('a challenge that renders after load beats layout in open', async () => {
    const lateSite = createGreenhouseSite({ fetchJob: async () => api, stepMs: 1_500 });
    // O botão de envio nunca aparece e um desafio entra na tela depois do carregamento.
    await page.route(formUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<html><body><main></main></body></html>' }));
    await page.addInitScript((html) => { setTimeout(() => document.body.insertAdjacentHTML('afterbegin', html), 300); }, CHALLENGE);
    expect(await lateSite.open(page, target)).toEqual({ kind: 'form' });
    expect(await lateSite.humanGate(page)).toBe('captcha');
  });

  it('never drops an answer it cannot place: a value for a question without control is a layout error', async () => {
    await site.open(page, target);
    const missing = mapped.find((q) => !q.required && q.kind === 'select' && q.id === 'race')!;
    await expect(site.fillStep(page, [ans(missing.id, missing.options[0])], files)).rejects.toBeInstanceOf(SiteLayoutError);
    await expect(site.fillStep(page, [ans(missing.id, null)], files)).resolves.toBeUndefined();
  });

  it('does not guess between two controls with the same label', async () => {
    const extra = { label: 'Dup', required: false, fields: [{ name: 'dup_q', type: 'input_text', values: [] }] };
    const dup = createGreenhouseSite({ fetchJob: async () => ({ ...api, questions: [...api.questions, extra] }), stepMs: 5_000 });
    await dup.open(page, target);
    await inject(page, '<label>Dup <input></label><label>Dup <input></label>');
    await expect(dup.fillStep(page, [ans('dup_q', 'x')], files)).rejects.toBeInstanceOf(SiteLayoutError);
  });

  it('surfaces a challenge that appears after the click as a rejection, not after the whole wait', async () => {
    const patient = createGreenhouseSite({ fetchJob: async () => api, stepMs: 5_000, submitMs: 20_000 });
    await patient.open(page, target);
    await page.evaluate((html) => { document.addEventListener('click', () => document.body.insertAdjacentHTML('afterbegin', html), true); }, CHALLENGE);
    const started = Date.now();
    await expect(patient.submit(page)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not take the phrase in the job description for a confirmation while the form is on the page', async () => {
    const clicks = await watchClicks(page);
    await site.open(page, target);
    await inject(page, '<p>Thank you for applying to our team, we read every application.</p>');
    await expect(site.submit(page)).rejects.toBeInstanceOf(Error);
    await page.waitForTimeout(300);
    expect(clicks.filter((c) => /submit application/i.test(c))).toHaveLength(1);
  });

  it('clears earlier selections before picking in a multiselect', async () => {
    const extra = { label: 'Langs', required: false, fields: [{ name: 'ms', type: 'multi_value_multi_select', values: ['A', 'B', 'C'].map((label, value) => ({ label, value })) }] };
    const multiSite = createGreenhouseSite({ fetchJob: async () => ({ ...api, questions: [...api.questions, extra] }), stepMs: 5_000 });
    await multiSite.open(page, target);
    // Imita o componente de lista do formulário (mesmas classes e papéis): o menu abre dentro do contêiner.
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.className = 'select__container';
      box.innerHTML = '<div class="select__multi-value__label">C</div><button type="button" class="select__clear-indicator">x</button><input id="ms" role="combobox" aria-expanded="false"><ul role="listbox" hidden></ul>';
      document.body.prepend(box);
      const input = box.querySelector('input')!;
      const menu = box.querySelector('ul')!;
      box.querySelector('button')!.addEventListener('click', () => box.querySelectorAll('.select__multi-value__label').forEach((e) => e.remove()));
      input.addEventListener('click', () => {
        menu.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        menu.innerHTML = ['A', 'B', 'C'].map((o) => '<li role="option">' + o + '</li>').join('');
      });
      menu.addEventListener('click', (e) => {
        const label = document.createElement('div');
        label.className = 'select__multi-value__label';
        label.textContent = (e.target as HTMLElement).textContent;
        box.prepend(label);
      });
    });
    await multiSite.fillStep(page, [ans('ms', ['A', 'B'])], files);
    expect(await page.locator('.select__multi-value__label').allTextContents()).toEqual(['B', 'A']);
  });

  it('answers logged_in without navigating', async () => {
    expect(await site.sessionState(page)).toBe('logged_in');
    expect(page.url()).toBe('about:blank');
  });
});
