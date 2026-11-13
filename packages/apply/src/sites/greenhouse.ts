import type { Locator, Page } from 'playwright';
import type { Question, QuestionKind, ResolvedAnswer } from '@kv/shared';
import { SiteLayoutError, SubmitRejectedError } from '../types';
import type { ApplyJob, ApplySite, ApplyTarget, HumanGate, StepRead } from '../types';
import { SITE_TIMEOUTS, leaveForm, matchOption, sameText, visibleCaptcha, visibleCodePrompt } from './shared';

const EMBED = 'https://job-boards.greenhouse.io/embed/job_app';
const GREENHOUSE_HOSTS = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io']);
const BOARD = /^[A-Za-z0-9_-]+$/;
const JOB_ID = /^\d+$/;

function target(board: string, jobId: string): ApplyTarget | null {
  if (!BOARD.test(board) || !JOB_ID.test(jobId)) return null;
  return { site: 'greenhouse', url: `${EMBED}?for=${board}&token=${jobId}`, ref: { board, jobId } };
}

/** Decide sem rede, pelo endereço e, com `gh_jid`, pelo `externalId` (`<board>-<id>`, partido no último hífen). */
export function greenhouseTarget(job: ApplyJob): ApplyTarget | null {
  let url: URL;
  try {
    url = new URL(job.url);
  } catch {
    return null;
  }
  if (GREENHOUSE_HOSTS.has(url.hostname)) {
    const path = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/);
    if (path && path[1] !== 'embed') return target(path[1], path[2]);
    if (url.pathname === '/embed/job_app') return target(url.searchParams.get('for') ?? '', url.searchParams.get('token') ?? '');
    return null;
  }
  if (job.source !== 'greenhouse' || !url.searchParams.get('gh_jid')) return null;
  const cut = job.externalId.lastIndexOf('-');
  if (cut <= 0) return null;
  return target(job.externalId.slice(0, cut), job.externalId.slice(cut + 1));
}

interface ApiField { name?: string; type?: string; values?: Array<{ label?: string }> }
interface ApiQuestion { label?: string; description?: string | null; required?: boolean; fields?: ApiField[] }

const KINDS: Record<string, QuestionKind> = {
  input_text: 'text',
  textarea: 'longtext',
  input_file: 'file',
  multi_value_single_select: 'select',
  multi_value_multi_select: 'multiselect',
};

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function mapQuestion(raw: ApiQuestion): Question | null {
  const fields = asList(raw.fields).filter((f): f is ApiField => !!f && typeof f === 'object')
    .filter((f) => f.type !== 'input_hidden');
  const field = fields.find((f) => f.type === 'input_file') ?? fields[0];
  const required = raw.required === true;
  const kind = field?.type ? KINDS[field.type] : undefined;
  if (!field || !field.name || !kind) {
    if (required) throw new SiteLayoutError(`pergunta obrigatória "${raw.label ?? ''}" com tipo de campo desconhecido (${field?.type ?? 'sem campo'})`);
    return null;
  }
  const options = kind === 'select' || kind === 'multiselect'
    ? asList(field.values).map((v) => String((v as { label?: string }).label ?? ''))
    : [];
  return {
    id: field.name,
    label: String(raw.label ?? ''),
    help: raw.description ? stripTags(raw.description) : '',
    kind,
    options,
    required,
    maxLength: null,
  };
}

/** Uma pergunta por controle da API, na ordem em que o formulário as mostra. */
export function mapGreenhouseQuestions(api: unknown): Question[] {
  return apiBlocks(api).flatMap((raw) => {
    const question = mapQuestion(raw as ApiQuestion);
    return question ? [question] : [];
  });
}

export interface GreenhouseDeps {
  fetchJob(board: string, jobId: string): Promise<unknown | null>;
  stepMs: number;
  submitMs: number;
}

const API_ROOT = 'https://boards-api.greenhouse.io/v1/boards';

/** `null` quando a vaga não existe mais (404); qualquer outro status é erro passageiro. */
async function fetchJobFromApi(board: string, jobId: string): Promise<unknown | null> {
  const url = `${API_ROOT}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}?questions=true`;
  const response = await fetch(url, { signal: AbortSignal.timeout(SITE_TIMEOUTS.pageMs) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Greenhouse respondeu ${response.status} para ${board}/${jobId}`);
  return response.json();
}

const SUBMIT_BUTTON = /^\s*submit application\s*$/i;
const THANKS = /thank you for applying/i;

/** Todo bloco de perguntas da API, na ordem em que o formulário os mostra. */
function apiBlocks(api: unknown): unknown[] {
  const root = (api && typeof api === 'object' ? api : {}) as Record<string, unknown>;
  const blocks: unknown[] = [...asList(root.questions), ...asList(root.location_questions)];
  for (const section of asList(root.compliance)) blocks.push(...asList((section as { questions?: unknown }).questions));
  blocks.push(...asList((root.demographic_questions as { questions?: unknown } | null | undefined)?.questions));
  return blocks;
}

function allFieldNames(api: unknown): Set<string> {
  const names = new Set<string>();
  for (const block of apiBlocks(api)) {
    for (const field of asList((block as ApiQuestion).fields)) {
      const name = (field as ApiField).name;
      if (name) names.add(name);
    }
  }
  return names;
}

/** O controle de uma pergunta: o elemento de `id` igual ao `name`; senão, o rótulo acessível; no arquivo, o grupo. */
async function findControl(page: Page, question: Question): Promise<Locator | null> {
  const byId = page.locator(`[id=${JSON.stringify(question.id)}]`);
  if (await byId.count()) return byId.first();
  const byLabel = page.getByLabel(question.label, { exact: true });
  if (await byLabel.count()) return byLabel.first();
  if (question.kind === 'file') {
    const group = page.locator(`[aria-labelledby=${JSON.stringify(`upload-label-${question.id}`)}]`);
    if (await group.count()) return group.first();
  }
  return null;
}

/** Caixas de marcação obrigatórias que não são campo da API (os consentimentos de `data_compliance`). */
async function consentQuestions(page: Page, known: Set<string>): Promise<Question[]> {
  const found = await page.evaluate((names) => {
    return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).flatMap((box) => {
      const id = box.getAttribute('name') || box.id;
      const required = box.required || box.getAttribute('aria-required') === 'true';
      if (!id || !required || names.includes(id) || names.includes(box.id)) return [];
      const label = box.labels?.[0]?.textContent ?? box.closest('label')?.textContent ?? box.getAttribute('aria-label') ?? '';
      return [{ id, label: label.replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim() }];
    });
  }, [...known]);
  return found.map(({ id, label }) => ({ id, label, help: '', kind: 'boolean' as const, options: [], required: true, maxLength: null }));
}

function consentBox(page: Page, id: string): Locator {
  const quoted = JSON.stringify(id);
  return page.locator(`input[type="checkbox"][name=${quoted}], input[type="checkbox"][id=${quoted}]`).first();
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Abre a lista, espera as opções e devolve o texto de cada uma. */
async function openList(page: Page, control: Locator, waitMs: number): Promise<{ options: Locator; texts: string[] }> {
  const options = page.getByRole('option');
  if (!(await options.count())) await control.click({ timeout: waitMs });
  try {
    await options.first().waitFor({ state: 'visible', timeout: waitMs });
  } catch {
    throw new SiteLayoutError('a lista de opções não abriu');
  }
  return { options, texts: (await options.allTextContents()).map(squash) };
}

function listContainer(control: Locator): Locator {
  return control.locator('xpath=ancestor::div[contains(@class,"select__container")][1]');
}

/** O texto que a lista da pergunta mostra como escolhido. */
async function shownChoice(control: Locator): Promise<string[]> {
  const shown = listContainer(control).locator('.select__single-value, .select__multi-value__label');
  return (await shown.allTextContents()).map(squash);
}

async function pickOne(page: Page, control: Locator, wanted: string, waitMs: number): Promise<void> {
  const { options, texts } = await openList(page, control, waitMs);
  const exact = matchOption(texts, wanted);
  if (exact === null) {
    await control.press('Escape').catch(() => {});
    throw new SiteLayoutError(`"${wanted}" não é uma das opções oferecidas`);
  }
  await options.nth(texts.indexOf(exact)).click({ timeout: waitMs });
  if (!(await shownChoice(control)).some((shown) => sameText(shown, exact))) {
    throw new SiteLayoutError(`a lista não passou a mostrar "${exact}"`);
  }
}

/** Campo de cidade com sugestões: digita, espera a lista por até 3 s e clica na que é igual ao valor ou começa por ele. */
async function typeWithSuggestions(page: Page, control: Locator, value: string): Promise<void> {
  await control.fill(value);
  const options = page.getByRole('option');
  try {
    await options.first().waitFor({ state: 'visible', timeout: 3_000 });
  } catch {
    return; // sem lista: o texto digitado fica
  }
  const texts = (await options.allTextContents()).map((t) => squash(t).toLowerCase());
  const wanted = squash(value).toLowerCase();
  const equal = texts.indexOf(wanted);
  const index = equal >= 0 ? equal : texts.findIndex((t) => t.startsWith(wanted));
  if (index >= 0) await options.nth(index).click();
}

async function clearChoice(control: Locator): Promise<void> {
  if (!(await shownChoice(control)).length) return;
  const clear = listContainer(control).locator('.select__clear-indicator');
  if (await clear.count()) {
    await clear.first().click();
    return;
  }
  await control.focus();
  await control.press('Backspace');
}

async function fillOne(page: Page, question: Question, control: Locator, answer: ResolvedAnswer, resumePath: string, waitMs: number): Promise<void> {
  const { value } = answer;
  const empty = value === null || value === '';
  switch (question.kind) {
    case 'file':
      // Só o campo de currículo recebe arquivo; o outro campo de arquivo nunca.
      if (question.id === 'resume' && !empty && (await control.evaluate((el) => el.tagName === 'INPUT'))) {
        await control.setInputFiles(resumePath);
      }
      return;
    case 'select':
      if (empty) return clearChoice(control);
      return pickOne(page, control, String(value), waitMs);
    case 'multiselect': {
      const wanted = empty ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
      if (!wanted.length) return clearChoice(control);
      for (const option of wanted) await pickOne(page, control, option, waitMs);
      return;
    }
    default:
      if (empty) return control.fill('');
      if ((await control.getAttribute('role')) === 'combobox') return typeWithSuggestions(page, control, String(value));
      return control.fill(String(value));
  }
}

async function confirmationText(page: Page): Promise<string | null> {
  const thanks = page.getByText(THANKS).first();
  if ((await thanks.count()) && (await thanks.isVisible())) return squash((await thanks.textContent()) ?? '');
  if (!/confirmation/i.test(new URL(page.url()).pathname)) return null;
  const heading = page.getByRole('heading').first();
  const text = (await heading.count()) ? squash((await heading.textContent()) ?? '') : '';
  return text || 'Application submitted';
}

const submitButton = (page: Page): Locator => page.getByRole('button', { name: SUBMIT_BUTTON });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createGreenhouseSite(deps: Partial<GreenhouseDeps> = {}): ApplySite {
  const fetchJob = deps.fetchJob ?? fetchJobFromApi;
  const stepMs = deps.stepMs ?? SITE_TIMEOUTS.stepMs;
  const submitMs = deps.submitMs ?? SITE_TIMEOUTS.submitMs;
  const apis = new WeakMap<Page, unknown>();

  const apiOf = (page: Page): unknown => {
    if (!apis.has(page)) throw new SiteLayoutError('o formulário da Greenhouse não foi aberto por este roteiro');
    return apis.get(page);
  };

  async function gate(page: Page): Promise<HumanGate | null> {
    if (await visibleCaptcha(page)) return 'captcha';
    if (await visibleCodePrompt(page)) return 'verification_code';
    return null;
  }

  const fieldErrorVisible = async (page: Page): Promise<boolean> =>
    (await page.locator('[aria-invalid="true"]:visible, [role="alert"]:visible').count()) > 0;

  const formOnScreen = async (page: Page): Promise<boolean> => {
    const button = submitButton(page);
    return (await button.count()) > 0 && (await button.first().isVisible());
  };

  return {
    id: 'greenhouse',
    needsLogin: false,

    match: greenhouseTarget,

    async sessionState() {
      return 'logged_in';
    },

    async open(page, target) {
      const api = await fetchJob(target.ref.board, target.ref.jobId);
      if (api === null) return { kind: 'unavailable', reason: 'closed' };
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: SITE_TIMEOUTS.pageMs });
      apis.set(page, api);
      if (await gate(page)) return { kind: 'form' };
      try {
        await submitButton(page).waitFor({ state: 'visible', timeout: stepMs });
      } catch {
        throw new SiteLayoutError('o botão "Submit application" não apareceu na página da Greenhouse');
      }
      // O botão vem no HTML do servidor; as listas só respondem depois que a página foi hidratada.
      await page.waitForFunction(
        () => Object.keys(document.querySelector('button[type="submit"]') ?? {}).some((k) => k.startsWith('__reactProps')),
        undefined,
        { timeout: stepMs },
      ).catch(() => {});
      return { kind: 'form' };
    },

    async readStep(page): Promise<StepRead> {
      const api = apiOf(page);
      const mapped = mapGreenhouseQuestions(api);
      for (const question of mapped) {
        if (question.required && !(await findControl(page, question))) {
          throw new SiteLayoutError(`a pergunta obrigatória "${question.label}" não tem controle na página`);
        }
      }
      return { questions: [...mapped, ...(await consentQuestions(page, allFieldNames(api)))], isLast: true };
    },

    async fillStep(page, answers, files) {
      const byId = new Map(mapGreenhouseQuestions(apiOf(page)).map((q) => [q.id, q]));
      for (const answer of answers) {
        const question = byId.get(answer.questionId);
        if (!question) {
          const box = consentBox(page, answer.questionId);
          if (await box.count()) await box.setChecked(answer.value === true || answer.value === 'true');
          continue; // resposta de pergunta que não está na etapa: ignorada
        }
        const control = await findControl(page, question);
        if (control) await fillOne(page, question, control, answer, files.resumePath, stepMs);
      }
    },

    async next() {
      throw new SiteLayoutError('o formulário da Greenhouse tem uma etapa só');
    },

    async submit(page) {
      apiOf(page);
      const done = await confirmationText(page);
      if (done) return { confirmation: done };
      if (!(await formOnScreen(page))) {
        throw new SiteLayoutError('o formulário da Greenhouse não está na tela: confira no site se a candidatura foi enviada');
      }
      await submitButton(page).first().click({ timeout: stepMs });

      const deadline = Date.now() + submitMs;
      while (Date.now() < deadline) {
        try {
          const confirmation = await confirmationText(page);
          const onScreen = await formOnScreen(page);
          if (confirmation && !onScreen) return { confirmation };
          if (!confirmation && onScreen && (await fieldErrorVisible(page))) {
            throw new SiteLayoutError('a Greenhouse mostrou erro em um campo do formulário');
          }
        } catch (error) {
          if (error instanceof SiteLayoutError) throw error;
          // A página está trocando de documento; tenta de novo no próximo ciclo.
        }
        await sleep(150);
      }
      const confirmation = await confirmationText(page).catch(() => null);
      const onScreen = await formOnScreen(page).catch(() => false);
      if (confirmation && !onScreen) return { confirmation };
      if (onScreen) {
        if (await fieldErrorVisible(page)) throw new SiteLayoutError('a Greenhouse mostrou erro em um campo do formulário');
        throw new SubmitRejectedError('a Greenhouse não confirmou o envio nem apontou erro no formulário');
      }
      throw new SiteLayoutError('o formulário saiu da tela sem confirmação: confira no site se a candidatura foi enviada');
    },

    humanGate: gate,

    async discard(page) {
      await leaveForm(page);
    },
  };
}

export const greenhouseSite: ApplySite = createGreenhouseSite();
