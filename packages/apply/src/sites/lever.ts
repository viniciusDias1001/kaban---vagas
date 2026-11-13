import type { Locator, Page } from 'playwright';
import type { Question, ResolvedAnswer } from '@kv/shared';
import { SiteLayoutError } from '../types';
import type { ApplyJob, ApplySite, ApplyTarget, StepRead } from '../types';
import {
  SITE_TIMEOUTS, buttonOnScreen, fieldErrorOnScreen, forgetSubmitClick, humanGateOf, leaveForm, matchOption, sleep, squash, submitAndWait,
  typeWithSuggestions,
} from './shared';

const COMPANY = /^[A-Za-z0-9_-]+$/;
const POSTING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decide sem rede, só pelo endereço: `jobs.lever.co/<empresa>/<id>`, com ou sem `/apply`, barra final ou consulta. */
export function leverTarget(job: ApplyJob): ApplyTarget | null {
  let url: URL;
  try {
    url = new URL(job.url);
  } catch {
    return null;
  }
  if (url.hostname !== 'jobs.lever.co') return null;
  const path = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\/apply)?\/?$/);
  if (!path || !COMPANY.test(path[1]) || !POSTING_ID.test(path[2])) return null;
  const [, company, postingId] = path;
  return { site: 'lever', url: `https://jobs.lever.co/${company}/${postingId}/apply`, ref: { company, postingId } };
}

export interface LeverDeps { stepMs: number; parseMs: number; settleMs: number; submitMs: number }

const DEFAULTS: LeverDeps = { stepMs: SITE_TIMEOUTS.stepMs, parseMs: 20_000, settleMs: 1_500, submitMs: SITE_TIMEOUTS.submitMs };
const SUBMIT_BUTTON = /^\s*submit application\s*$/i;
const SUBMITTED = /application submitted|thanks? for (applying|your application)/i;
const FORM = '#application-form';

/** Como o roteiro enxerga um campo ou um grupo de campos do formulário. */
interface Field {
  question: Question;
  control: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file';
  suggests: boolean;
  /** Um `<select>` com opção de valor vazio (a de espera) pode ser esvaziado. */
  hasEmpty: boolean;
  /** Valor do atributo de cada opção, na mesma ordem de `question.options`. */
  values: string[];
}

// Os scripts de página são texto: o tsx envolve funções nomeadas em __name, que não existe na página.
const READ_FIELDS = `(() => {
  const squash = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const form = document.querySelector(${JSON.stringify(FORM)});
  if (!form) return null;
  const groups = new Map();
  for (const el of form.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type) || !el.name || /captcha-response$/i.test(el.name)) continue;
    const list = groups.get(el.name) || [];
    list.push(el);
    groups.set(el.name, list);
  }
  const fields = [];
  for (const [name, list] of groups) {
    const first = list[0];
    const type = (first.getAttribute('type') || 'text').toLowerCase();
    const tag = first.tagName.toLowerCase();
    if (type !== 'radio' && type !== 'checkbox' && list.length > 1) { fields.push({ duplicate: name }); continue; }
    const card = first.closest('li.application-question');
    const head = card && card.querySelector('.application-label');
    let label = '';
    if (head) {
      const copy = head.cloneNode(true);
      copy.querySelectorAll('.required').forEach((n) => n.remove());
      label = squash(copy.textContent);
    }
    if (!label && first.labels && first.labels[0]) label = squash(first.labels[0].textContent);
    if (!label) label = squash(first.getAttribute('aria-label') || first.getAttribute('placeholder') || name);
    label = label.replace(/\\s*✱\\s*$/, '');
    const required = list.some((el) => el.required || el.getAttribute('aria-required') === 'true') || !!(head && head.querySelector('.required'));
    const textOf = (el) => squash((el.closest('label') || {}).textContent) || el.value;
    let kind; let control; let options = []; let values = [];
    if (type === 'file') { kind = 'file'; control = 'file'; }
    else if (type === 'radio') { kind = 'select'; control = 'radio'; options = list.map(textOf); values = list.map((el) => el.value); }
    else if (type === 'checkbox') {
      control = 'checkbox';
      if (list.length > 1) { kind = 'multiselect'; options = list.map(textOf); values = list.map((el) => el.value); }
      else kind = 'boolean';
    } else if (tag === 'select') {
      kind = first.multiple ? 'multiselect' : 'select'; control = 'select';
      const real = Array.from(first.options).filter((o) => o.value !== '');
      options = real.map((o) => squash(o.textContent));
      values = real.map((o) => o.value);
    } else if (tag === 'textarea') { kind = 'longtext'; control = 'textarea'; }
    else { kind = 'text'; control = 'text'; }
    const max = parseInt(first.getAttribute('maxlength') || '', 10);
    fields.push({
      question: { id: name, label, help: '', kind, options, required, maxLength: Number.isFinite(max) ? max : null },
      control, values,
      hasEmpty: tag === 'select' && Array.from(first.options).some((o) => o.value === ''),
      suggests: first.classList.contains('location-input') || first.id === 'location-input',
    });
  }
  return fields;
})()`;

/** Algum elemento visível do controle de envio do currículo com texto de "lendo". */
const STILL_READING = `(() => {
  const input = document.querySelector('input[type="file"][name="resume"]');
  const root = input ? (input.closest('li.application-question') || input.parentElement) : null;
  if (!root) return false;
  const own = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
  return Array.from(root.querySelectorAll('*')).some((el) => /analyzing|analisando/i.test(own(el))
    && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
})()`;

/** O que o campo mostra agora, no formato de `Expected`; `null` se o campo sumiu. */
const readState = (name: string): string => `(() => {
  const squash = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const list = Array.from(document.querySelectorAll(${JSON.stringify(`${FORM} [name=${JSON.stringify(name)}]`)}));
  if (!list.length) return null;
  const first = list[0];
  const type = (first.getAttribute('type') || 'text').toLowerCase();
  const textOf = (el) => squash((el.closest('label') || {}).textContent) || el.value;
  if (type === 'radio') { const on = list.find((el) => el.checked); return on ? textOf(on) : ''; }
  if (type === 'checkbox') return list.length > 1 ? list.filter((el) => el.checked).map(textOf) : first.checked;
  if (first.tagName === 'SELECT') {
    const chosen = Array.from(first.selectedOptions).filter((o) => o.value !== '').map((o) => squash(o.textContent));
    return first.multiple ? chosen : (chosen[0] || '');
  }
  return first.value;
})()`;

type Expected = string | string[] | boolean;
interface Entry { field: Field; answer: ResolvedAnswer; chosen: string[]; expected: Expected }

const isEmpty = (value: ResolvedAnswer['value']): boolean => value === null || value === '' || (Array.isArray(value) && value.length === 0);
const isTrue = (value: ResolvedAnswer['value']): boolean => value === true || value === 'true';
const normalise = (value: Expected): Expected => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : value);
const same = (a: Expected, b: Expected): boolean => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

const submitButton = (page: Page): Locator => page.getByRole('button', { name: SUBMIT_BUTTON });
const controlsOf = (page: Page, name: string): Locator => page.locator(`${FORM} [name=${JSON.stringify(name)}]`);

async function readFields(page: Page): Promise<Field[]> {
  const raw = (await page.evaluate(READ_FIELDS)) as Array<Field & { duplicate?: string }> | null;
  if (!raw) throw new SiteLayoutError('o formulário de candidatura do Lever não está na página');
  const dup = raw.find((f) => f.duplicate);
  if (dup) throw new SiteLayoutError(`mais de um controle com o nome "${dup.duplicate}": não dá para escolher`);
  return raw;
}

/** Marca ou desmarca clicando no rótulo que envolve a caixa, e não no controle que o estilo costuma esconder. */
async function setChecked(box: Locator, wanted: boolean): Promise<void> {
  if ((await box.isChecked()) === wanted) return;
  const label = box.locator('xpath=ancestor::label[1]');
  if (await label.count()) await label.click();
  else await box.setChecked(wanted);
}

/** O texto exato de cada opção pedida, ou `SiteLayoutError`. Nunca aproxima. */
function resolveOptions(field: Field, answer: ResolvedAnswer): string[] {
  const asked = Array.isArray(answer.value) ? answer.value.map(String) : isEmpty(answer.value) ? [] : [String(answer.value)];
  if (field.question.kind === 'select' && asked.length > 1) throw new SiteLayoutError(`"${field.question.label}" aceita uma opção só`);
  if (field.question.kind !== 'select' && field.question.kind !== 'multiselect') return [];
  return asked.map((wanted) => {
    const exact = matchOption(field.question.options, wanted);
    if (exact === null) throw new SiteLayoutError(`"${wanted}" não é uma das opções oferecidas em "${field.question.label}"`);
    return exact;
  });
}

/** Esvaziar é impossível quando o site não oferece como: erro antes de qualquer campo ser tocado. */
async function assertCanEmpty(page: Page, field: Field): Promise<void> {
  if (field.control === 'select' && field.question.kind === 'select' && !field.hasEmpty) {
    throw new SiteLayoutError(`"${field.question.label}" não tem opção vazia: não dá para deixá-lo em branco`);
  }
  if (field.control === 'radio' && (await page.evaluate(readState(field.question.id))) !== '') {
    throw new SiteLayoutError(`não é possível limpar a escolha já feita em "${field.question.label}"`);
  }
}

/** Põe a resposta no campo. */
async function fillField(page: Page, { field, answer, chosen }: Entry): Promise<void> {
  const controls = controlsOf(page, field.question.id);
  const empty = isEmpty(answer.value);
  const valueOf = (option: string): string => field.values[field.question.options.indexOf(option)];
  if (field.control === 'select') {
    const picked = field.question.kind === 'multiselect' ? chosen.map(valueOf) : [chosen[0] === undefined ? '' : valueOf(chosen[0])];
    await controls.first().selectOption(picked.map((value) => ({ value })));
  } else if (field.control === 'radio') {
    if (!empty) await setChecked(controls.nth(field.question.options.indexOf(chosen[0])), true);
  } else if (field.control === 'checkbox') {
    if (field.question.kind === 'boolean') await setChecked(controls.first(), isTrue(answer.value));
    else for (let i = 0; i < field.question.options.length; i++) await setChecked(controls.nth(i), chosen.includes(field.question.options[i]));
  } else if (empty) await controls.first().fill('');
  else if (field.suggests) await typeWithSuggestions(controls.first(), async () => page.locator('.dropdown-location'), String(answer.value));
  else await controls.first().fill(String(answer.value));
}

/** O que o campo deve mostrar depois de preenchido. Na cidade com sugestões, o que ficou depois da sugestão. */
async function expectedOf(page: Page, entry: Entry): Promise<Expected> {
  const { field, answer, chosen } = entry;
  if (field.suggests) return (await page.evaluate(readState(field.question.id))) as Expected;
  if (field.question.kind === 'boolean') return isTrue(answer.value);
  if (field.question.kind === 'multiselect') return field.question.options.filter((o) => chosen.includes(o));
  if (field.question.kind === 'select') return chosen[0] ?? '';
  return isEmpty(answer.value) ? '' : String(answer.value);
}

export function createLeverSite(deps: Partial<LeverDeps> = {}): ApplySite {
  const { stepMs, parseMs, settleMs, submitMs } = { ...DEFAULTS, ...deps };

  const gate = humanGateOf;
  const formOnScreen = (page: Page): Promise<boolean> => buttonOnScreen(submitButton(page));
  const fieldErrorVisible = (page: Page): Promise<boolean> => fieldErrorOnScreen(page, `${FORM} :invalid:visible`);


  /** A página de "vaga não encontrada" do Lever: sem formulário, e com o título ou o aviso de erro dizendo isso. */
  const isClosed = (page: Page): Promise<boolean> => page.evaluate(`(() => {
    if (document.querySelector(${JSON.stringify(FORM)})) return false;
    const notice = (document.querySelector('.error-message') || {}).textContent || '';
    return /not found|404/i.test(document.title) || /couldn't find anything|404 error/i.test(notice);
  })()`) as Promise<boolean>;

  /** O texto de confirmação, só com o formulário fora da página: a mesma frase na descrição da vaga não vale. */
  async function confirmationText(page: Page): Promise<string | null> {
    if (await formOnScreen(page)) return null;
    const done = page.getByText(SUBMITTED).first();
    if ((await done.count()) && (await done.isVisible())) return squash((await done.textContent()) ?? '');
    if (!/\/thanks\/?$/.test(new URL(page.url()).pathname)) return null;
    const heading = page.getByRole('heading').first();
    const text = (await heading.count()) ? squash((await heading.textContent()) ?? '') : '';
    return text || 'Application submitted';
  }

  /** Os campos que não mostram mais o que foi posto neles. */
  async function differing(page: Page, entries: Entry[]): Promise<Entry[]> {
    const off: Entry[] = [];
    for (const entry of entries) {
      const shown = (await page.evaluate(readState(entry.field.question.id))) as Expected | null;
      if (shown === null || !same(shown, entry.expected)) off.push(entry);
    }
    return off;
  }

  return {
    id: 'lever',
    needsLogin: false,

    match: leverTarget,

    async sessionState() {
      return 'logged_in';
    },

    async open(page, target) {
      forgetSubmitClick(page);
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: SITE_TIMEOUTS.pageMs });
      if (await gate(page)) return { kind: 'form' };
      if (await isClosed(page)) return { kind: 'unavailable', reason: 'closed' };
      try {
        await submitButton(page).waitFor({ state: 'visible', timeout: stepMs });
      } catch {
        if (await gate(page)) return { kind: 'form' }; // portão vence layout
        throw new SiteLayoutError('o botão "Submit application" não apareceu na página do Lever');
      }
      return { kind: 'form' };
    },

    async readStep(page): Promise<StepRead> {
      const fields = await readFields(page);
      return { questions: fields.map((f) => f.question), isLast: true };
    },

    async fillStep(page, answers, files) {
      const fields = new Map((await readFields(page)).map((f) => [f.question.id, f]));
      // Tudo é conferido contra a página antes de tocar em qualquer campo.
      const entries: Entry[] = [];
      let upload = false;
      for (const answer of answers) {
        const field = fields.get(answer.questionId);
        if (!field) {
          if (!isEmpty(answer.value)) throw new SiteLayoutError(`a resposta para "${answer.questionId}" não tem controle na página`);
          continue;
        }
        if (field.control === 'file') {
          // Só o campo de currículo recebe arquivo; o outro campo de arquivo nunca.
          if (isEmpty(answer.value)) continue;
          if (field.question.id !== 'resume') throw new SiteLayoutError(`o campo de arquivo "${field.question.label}" não recebe arquivo: só o do currículo`);
          upload = true;
          continue;
        }
        if (isEmpty(answer.value)) await assertCanEmpty(page, field);
        entries.push({ field, answer, chosen: resolveOptions(field, answer), expected: '' });
      }

      // (1) o currículo, que faz o site ler e preencher campos por conta própria
      if (upload) await controlsOf(page, 'resume').first().setInputFiles(files.resumePath);

      // (2) espera a leitura assentar
      const deadline = Date.now() + parseMs;
      while (await page.evaluate(STILL_READING)) {
        if (Date.now() >= deadline) throw new SiteLayoutError('o Lever não terminou de ler o currículo a tempo');
        await sleep(100);
      }

      // (3) preenche tudo, esvaziando o que a resposta deixa em branco
      for (const entry of entries) {
        await fillField(page, entry);
        entry.expected = await expectedOf(page, entry);
      }

      // (4) confere depois de `settleMs`; refaz uma vez o que mudou; se ainda diferir depois de outro `settleMs`, é erro
      await sleep(settleMs);
      let off = await differing(page, entries);
      if (!off.length) return;
      for (const entry of off) {
        await fillField(page, entry);
        entry.expected = await expectedOf(page, entry);
      }
      await sleep(settleMs);
      off = await differing(page, entries);
      if (off.length) throw new SiteLayoutError(`o Lever mudou o campo "${off[0].field.question.label}" depois de preenchido`);
    },

    async next() {
      throw new SiteLayoutError('o formulário do Lever tem uma etapa só');
    },
    async submit(page) {
      return submitAndWait(page, {
        site: 'Lever',
        submitButton: submitButton(page),
        formOnScreen: () => formOnScreen(page),
        confirmationText: () => confirmationText(page),
        fieldErrorVisible: () => fieldErrorVisible(page),
        gate: () => gate(page),
        stepMs,
        submitMs,
      });
    },


    humanGate: gate,

    async discard(page) {
      await leaveForm(page);
    },
  };
}

export const leverSite: ApplySite = createLeverSite();
