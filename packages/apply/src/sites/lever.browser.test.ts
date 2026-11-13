import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Question } from '@kv/shared';
import { SiteLayoutError, SubmitRejectedError } from '../types';
import { openFixture } from '../testing';
import { ans, fakeResumePath, fixturePath, inject, job, linkSteps, replayRoutes, watchClicks, watchWrites } from './fixtures';
import { createLeverSite, leverTarget } from './lever';

// As páginas gravadas ficam só na máquina de quem as gravou (pasta ignorada pelo git): sem elas, os testes que as usam são pulados.
const missing = ['form/routes.json', 'rendered.html', 'closed.html'].filter((f) => !existsSync(fixturePath('lever', f)));
const recorded = missing.length === 0;
const routes = recorded ? replayRoutes('lever', 'form') : {};
const formUrl = Object.keys(routes).find((u) => /\/apply$/.test(u)) ?? 'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply';
const RENDERED = formUrl.replace(/\/apply$/, '/rendered');
const CLOSED = formUrl.replace(/\/apply$/, '/closed');
const DONE = formUrl.replace(/\/apply$/, '/thanks');
const target = leverTarget(job({ source: 'lever', url: formUrl }))!;
const site = createLeverSite({ stepMs: 5_000, parseMs: 3_000, settleMs: 300, submitMs: 1_500 });
const files = { resumePath: fakeResumePath() };
const CHALLENGE = '<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge" width="400" height="600" style="position:fixed;top:0;left:0"></iframe>';

let page: Page;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ page, close } = await openFixture({
    ...routes,
    [RENDERED]: fixturePath('lever', 'rendered.html'),
    [CLOSED]: fixturePath('lever', 'closed.html'),
    [DONE]: fixturePath('lever', 'confirmation.synthetic.html'),
  }));
});
afterEach(async () => { await close?.(); });

const find = (qs: Question[], re: RegExp): Question => qs.find((q) => re.test(q.label))!;
const resumeAnd = (qs: Question[], name: string | null) => [ans(find(qs, /resume|cv/i).id, 'cv.pdf'), ans(find(qs, /full name/i).id, name)];
const inForm = (p: Page, html: string): Promise<void> => p.evaluate(`document.querySelector('#application-form').insertAdjacentHTML('afterbegin', ${JSON.stringify(html)})`).then(() => undefined);
const fullName = (): Promise<string> => page.getByLabel(/full name/i).inputValue();

/** Rótulos das caixas marcadas do grupo. */
async function checkedLabels(p: Page, q: Question): Promise<string[]> {
  return p.locator(`input[type="checkbox"][name=${JSON.stringify(q.id)}]:checked`)
    .evaluateAll((boxes) => boxes.map((box) => (box.closest('label')?.textContent ?? '').replace(/\s+/g, ' ').trim()));
}

/**
 * O Lever lê o currículo sozinho, e a página gravada não tem JavaScript. Ao receber o arquivo, mostra "Analyzing resume..."
 * (o `.resume-upload-working` do formulário) por `analyzingMs` e então escreve `parsedName` no campo "Full name". Com
 * `lateMs`, escreve `parsedName` de novo, uma única vez, `lateMs` depois de o campo receber outro valor.
 */
async function emulateAutoRead(p: Page, opts: { analyzingMs: number; parsedName: string; lateMs?: number }): Promise<void> {
  await p.evaluate(`(() => {
    const opts = ${JSON.stringify(opts)};
    const input = document.querySelector('input[name="resume"]');
    const name = document.querySelector('input[name="name"]');
    const working = document.querySelector('.resume-upload-working');
    let late = false;
    if (opts.lateMs !== undefined) {
      name.addEventListener('input', () => {
        if (late || name.value === opts.parsedName) return;
        late = true;
        setTimeout(() => { name.value = opts.parsedName; }, opts.lateMs);
      });
    }
    input.addEventListener('change', () => {
      working.style.display = 'block';
      setTimeout(() => {
        working.style.display = 'none';
        name.value = opts.parsedName;
      }, opts.analyzingMs);
    });
  })()`);
}

describe.skipIf(!recorded)(recorded ? 'lever site' : `lever site (missing recording: ${missing.join(', ')}; run pnpm apply:fixtures)`, () => {
  it('opens the form and reads standard fields and custom cards', async () => {
    expect(await site.open(page, target)).toEqual({ kind: 'form' });
    const { questions, isLast } = await site.readStep(page);
    expect(isLast).toBe(true);
    expect(find(questions, /full name/i)).toMatchObject({ kind: 'text', required: true });
    expect(find(questions, /email/i)).toMatchObject({ kind: 'text', required: true });
    expect(find(questions, /resume|cv/i)).toMatchObject({ kind: 'file' });
    expect(find(questions, /phone/i)).toMatchObject({ kind: 'text', required: false });
    expect(find(questions, /current location/i)).toMatchObject({ kind: 'text', required: true, maxLength: 100 });
    expect(find(questions, /additional information/i)).toMatchObject({ kind: 'longtext', required: false });
    expect(find(questions, /language skill/i)).toMatchObject({ kind: 'multiselect', required: true });
    expect(find(questions, /legally authorized/i)).toMatchObject({ kind: 'select', options: ['Yes', 'No'], required: true });
    expect(find(questions, /which university/i)).toMatchObject({ kind: 'select', required: true });
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    expect(questions.filter((q) => q.kind === 'select' || q.kind === 'multiselect').every((q) => q.options.length > 0 && !q.options.includes(''))).toBe(true);
  });

  it('reports a posting that no longer exists as closed', async () => {
    expect(await site.open(page, { ...target, url: CLOSED })).toEqual({ kind: 'unavailable', reason: 'closed' });
  });

  describe('on the rendered form (no JavaScript), with the auto-read emulated', () => {
    let questions: Question[];
    beforeEach(async () => {
      await site.open(page, { ...target, url: RENDERED });
      questions = (await site.readStep(page)).questions;
    });

    it('waits for the résumé auto-read to settle, then overwrites what it wrote', async () => {
      await emulateAutoRead(page, { analyzingMs: 500, parsedName: 'Nome Lido Do PDF' });
      await site.fillStep(page, resumeAnd(questions, 'Ana Souza'), files);
      expect(await fullName()).toBe('Ana Souza');
    });

    it('refills a field the auto-read overwrites after the fill', async () => {
      await emulateAutoRead(page, { analyzingMs: 0, parsedName: 'Nome Lido Do PDF', lateMs: 100 });
      await site.fillStep(page, resumeAnd(questions, 'Ana Souza'), files);
      expect(await fullName()).toBe('Ana Souza');
    });

    it('empties a field the auto-read filled when the answer is null', async () => {
      await emulateAutoRead(page, { analyzingMs: 0, parsedName: 'Nome Lido Do PDF' });
      await site.fillStep(page, resumeAnd(questions, null), files);
      expect(await fullName()).toBe('');
    });

    it('stops with a layout error when the auto-read never settles', async () => {
      await emulateAutoRead(page, { analyzingMs: 60_000, parsedName: '' });
      await expect(createLeverSite({ parseMs: 400, settleMs: 50 }).fillStep(page, resumeAnd(questions, 'Ana Souza'), files)).rejects.toBeInstanceOf(SiteLayoutError);
    });

    it('stops with a layout error when a field keeps being overwritten', async () => {
      await page.evaluate(`(() => { const n = document.querySelector('input[name="name"]'); n.addEventListener('input', () => setTimeout(() => { n.value = 'Outro'; }, 20)); })()`);
      await expect(createLeverSite({ parseMs: 400, settleMs: 100 }).fillStep(page, [ans(find(questions, /full name/i).id, 'Ana Souza')], files)).rejects.toBeInstanceOf(SiteLayoutError);
    });

    it('uploads the résumé only into the résumé field', async () => {
      await site.fillStep(page, [ans(find(questions, /resume|cv/i).id, 'cv.pdf')], files);
      expect(await page.locator('input[name="resume"]').evaluate((el) => Array.from((el as HTMLInputElement).files ?? []).map((f) => f.name))).toEqual([basename(files.resumePath)]);
    });

    it('ticks exactly the chosen boxes of a custom card and refuses an option that is not offered', async () => {
      const multi = questions.find((q) => q.kind === 'multiselect')!;
      await site.fillStep(page, [ans(multi.id, [multi.options[0]])], files);
      expect(await checkedLabels(page, multi)).toEqual([multi.options[0]]);
      await site.fillStep(page, [ans(multi.id, [multi.options[2], multi.options[1]])], files);
      expect(await checkedLabels(page, multi)).toEqual([multi.options[1], multi.options[2]]);
      await expect(site.fillStep(page, [ans(multi.id, ['Opção que não existe'])], files)).rejects.toBeInstanceOf(SiteLayoutError);
      await site.fillStep(page, [ans(multi.id, null)], files);
      expect(await checkedLabels(page, multi)).toEqual([]);
    });

    it('refuses a look-alike option instead of approximating it', async () => {
      const multi = questions.find((q) => q.kind === 'multiselect')!;
      await expect(site.fillStep(page, [ans(multi.id, [`${multi.options[0]} (talvez)`])], files)).rejects.toBeInstanceOf(SiteLayoutError);
      expect(await checkedLabels(page, multi)).toEqual([]);
    });

    it('picks a radio option and an exact list option, and empties the list on null', async () => {
      const radio = find(questions, /legally authorized/i);
      const list = find(questions, /which university/i);
      await site.fillStep(page, [ans(radio.id, 'no'), ans(list.id, list.options[1])], files);
      expect(await page.locator(`input[type="radio"][name=${JSON.stringify(radio.id)}]:checked`).getAttribute('value')).toBe('No');
      expect(await page.locator(`select[name=${JSON.stringify(list.id)}]`).evaluate((s) => (s as HTMLSelectElement).selectedOptions[0].textContent)).toBe(list.options[1]);
      await expect(site.fillStep(page, [ans(radio.id, 'Talvez')], files)).rejects.toBeInstanceOf(SiteLayoutError);
      await site.fillStep(page, [ans(list.id, null)], files);
      expect(await page.locator(`select[name=${JSON.stringify(list.id)}]`).inputValue()).toBe('');
    });

    it('a field the page will not let it fill is a layout error, not a passing error (C-4)', async () => {
      page.setDefaultTimeout(800);
      await page.getByLabel(/full name/i).evaluate((el) => { (el as HTMLInputElement).disabled = true; });
      await expect(site.fillStep(page, [ans(find(questions, /full name/i).id, 'Ana Souza')], files)).rejects.toBeInstanceOf(SiteLayoutError);
      await inForm(page, '<input type="checkbox" name="escondida" style="display:none">');
      await expect(site.fillStep(page, [ans('escondida', true)], files)).rejects.toBeInstanceOf(SiteLayoutError);
    });

    it('fills a text card field and a long text, and a lone checkbox is a boolean', async () => {
      await inForm(page, '<label><input type="checkbox" name="lgpd" required> I agree to the processing of my data</label>');
      const read = (await site.readStep(page)).questions;
      expect(read.find((q) => q.id === 'lgpd')).toMatchObject({ kind: 'boolean', required: true, label: 'I agree to the processing of my data' });
      const text = find(read, /preferred name/i);
      const long = find(read, /proudest accomplishment/i);
      await site.fillStep(page, [ans('lgpd', true), ans(text.id, 'Ana'), ans(long.id, 'Linha 1\nLinha 2')], files);
      expect(await page.locator('input[name="lgpd"]').isChecked()).toBe(true);
      expect(await page.locator(`input[name=${JSON.stringify(text.id)}]`).inputValue()).toBe('Ana');
      expect(await page.locator(`textarea[name=${JSON.stringify(long.id)}]`).inputValue()).toBe('Linha 1\nLinha 2');
      await site.fillStep(page, [ans('lgpd', false)], files);
      expect(await page.locator('input[name="lgpd"]').isChecked()).toBe(false);
    });

    it('takes the suggestion of the location field whose text starts with the answer, and keeps what it shows', async () => {
      const location = find(questions, /current location/i);
      await page.evaluate(`(() => {
        const input = document.querySelector('input[name="location"]');
        const item = document.createElement('div');
        item.className = 'dropdown-location';
        item.textContent = 'São Paulo, State of São Paulo, Brazil';
        item.addEventListener('click', () => { input.value = item.textContent; });
        input.addEventListener('input', () => input.parentElement.appendChild(item));
      })()`);
      await site.fillStep(page, [ans(location.id, 'São Paulo')], files);
      expect(await page.locator('input[name="location"]').inputValue()).toBe('São Paulo, State of São Paulo, Brazil');
    });

    it('never drops an answer it cannot place: a value for an unknown question is a layout error', async () => {
      await expect(site.fillStep(page, [ans('cards[nao-existe][field0]', 'x')], files)).rejects.toBeInstanceOf(SiteLayoutError);
      await expect(site.fillStep(page, [ans('cards[nao-existe][field0]', null)], files)).resolves.toBeUndefined();
    });

    it('does not guess between two controls with the same name', async () => {
      await inForm(page, '<input type="text" name="dup"><input type="text" name="dup">');
      await expect(site.fillStep(page, [ans('dup', 'x')], files)).rejects.toBeInstanceOf(SiteLayoutError);
    });

    it('does not offer hidden inputs or a captcha response field as questions', async () => {
      const before = (await site.readStep(page)).questions.map((q) => q.id);
      await inForm(page, '<input type="hidden" name="token_oculto" value="x"><textarea name="h-captcha-response" style="display:none"></textarea><textarea name="g-recaptcha-response"></textarea>');
      expect((await site.readStep(page)).questions.map((q) => q.id)).toEqual(before);
    });

    it('checks every answer before touching any field: an invalid one leaves the valid one and the upload alone', async () => {
      const radio = find(questions, /legally authorized/i);
      const list = find(questions, /which university/i);
      await page.locator(`input[type="radio"][name=${JSON.stringify(radio.id)}][value="Yes"]`).evaluate((el) => { (el as HTMLInputElement).checked = true; });
      // a primeira resposta é válida, a segunda esvazia um grupo de rádio que já tem escolha
      for (const bad of [ans(radio.id, null), ans(list.id, 'Universidade que não existe')]) {
        await expect(site.fillStep(page, [ans(find(questions, /full name/i).id, 'Ana Souza'), ans(find(questions, /resume|cv/i).id, 'cv.pdf'), bad], files)).rejects.toBeInstanceOf(SiteLayoutError);
        expect(await fullName()).toBe('');
        expect(await page.locator('input[name="resume"]').evaluate((el) => (el as HTMLInputElement).files?.length ?? 0)).toBe(0);
      }
    });

    it('refuses a file answer for a field that is not the résumé, and a null on a list with no empty option', async () => {
      await inForm(page, '<input type="file" name="portfolio"><select name="sem_vazio"><option value="a">A</option><option value="b">B</option></select>');
      const read = (await site.readStep(page)).questions;
      expect(read.find((q) => q.id === 'portfolio')).toMatchObject({ kind: 'file' });
      await expect(site.fillStep(page, [ans('portfolio', 'cv.pdf')], files)).rejects.toBeInstanceOf(SiteLayoutError);
      await expect(site.fillStep(page, [ans('sem_vazio', null)], files)).rejects.toBeInstanceOf(SiteLayoutError);
      await expect(site.fillStep(page, [ans('portfolio', null)], files)).resolves.toBeUndefined();
    });

    it('does not call a loaded hCaptcha a gate; only a challenge on screen is one', async () => {
      expect(await site.humanGate(page)).toBeNull();
      await inject(page, CHALLENGE);
      expect(await site.humanGate(page)).toBe('captcha');
    });

    it('never reports success without a confirmation, and clicks the submit button once', async () => {
      const clicks = await watchClicks(page);
      await expect(site.submit(page)).rejects.toBeInstanceOf(SiteLayoutError); // campos obrigatórios vazios: erro de campo
      await page.waitForTimeout(300);
      expect(clicks.filter((c) => /submit application/i.test(c))).toHaveLength(1);
    });

    it('does not take the phrase in the job description for a confirmation while the form is on the page', async () => {
      const clicks = await watchClicks(page);
      await inject(page, '<h3>Application submitted!</h3>');
      await expect(site.submit(page)).rejects.toBeInstanceOf(SiteLayoutError);
      await page.waitForTimeout(300);
      expect(clicks.filter((c) => /submit application/i.test(c))).toHaveLength(1);
    });

    it('surfaces a challenge that appears after the click as a rejection, not after the whole wait', async () => {
      const patient = createLeverSite({ stepMs: 5_000, submitMs: 20_000 });
      await page.evaluate((html) => { document.addEventListener('click', () => document.body.insertAdjacentHTML('afterbegin', html), true); }, CHALLENGE);
      const started = Date.now();
      await expect(patient.submit(page)).rejects.toBeInstanceOf(SubmitRejectedError);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  it('submits once, returns the confirmation, never advances, and discards without sending', async () => {
    const clicks = await watchClicks(page);
    await linkSteps(page, [{ from: formUrl, button: /submit application/i, to: DONE }]);
    const writes = watchWrites(page);
    await site.open(page, target);
    await expect(site.next(page)).rejects.toBeInstanceOf(SiteLayoutError);
    expect(await site.submit(page)).toEqual({ confirmation: 'Application submitted!' });
    expect(await site.submit(page)).toEqual({ confirmation: 'Application submitted!' });
    expect(clicks).toHaveLength(1);
    const before = writes.length;
    await site.discard(page);
    expect(page.url()).toBe('about:blank');
    expect(writes.length).toBe(before);
  });
});

// Sem página gravada: a rota de `formUrl` é respondida pelo próprio teste, então estes sempre rodam.
describe('open and gates on a page the test serves itself', () => {
  it('a challenge that renders after load beats layout in open', async () => {
    const late = createLeverSite({ stepMs: 1_500 });
    await page.route(formUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.addInitScript((html) => { setTimeout(() => document.body.insertAdjacentHTML('afterbegin', html), 300); }, CHALLENGE);
    expect(await late.open(page, target)).toEqual({ kind: 'form' });
    expect(await late.humanGate(page)).toBe('captcha');
  });

  it('is a layout error when neither the form nor a gate shows up', async () => {
    await page.route(formUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<html><body><p>nada</p></body></html>' }));
    await expect(createLeverSite({ stepMs: 400 }).open(page, target)).rejects.toBeInstanceOf(SiteLayoutError);
  });

  it('answers logged_in without navigating', async () => {
    expect(await site.sessionState(page)).toBe('logged_in');
    expect(page.url()).toBe('about:blank');
  });
});
