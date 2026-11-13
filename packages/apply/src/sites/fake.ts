import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import type { Question, QuestionKind } from '@kv/shared';
import { SiteLayoutError } from '../types';
import type { ApplyJob, ApplySite, ApplyTarget, HumanGate, StepRead } from '../types';
import { buttonOnScreen, fieldErrorOnScreen, forgetSubmitClick, siteLayoutErrors, squash, submitAndWait } from './shared';

export const FAKE_SITE_ORIGIN = 'http://apply.fake.test';

/**
 * `captcha-sends`: o primeiro clique em Enviar abre uma verificação; resolvida, o envio continua sozinho um segundo
 * depois (como o retorno de um captcha invisível), com a resposta do captcha preenchida. `captcha-idle`: a mesma
 * verificação, mas resolvida o formulário fica parado e só um novo clique envia. As duas contam cliques em Enviar e
 * candidaturas registradas em `data-clicks` e `data-sends` do `body`.
 */
const VARIANTS = ['form', 'two-steps', 'closed', 'already-applied', 'captcha', 'rejected', 'broken', 'captcha-sends', 'captcha-idle'] as const;
type FakeVariant = (typeof VARIANTS)[number];

export function isFakeVariant(v: string): v is FakeVariant {
  return (VARIANTS as readonly string[]).includes(v);
}

/** Caminho absoluto do HTML de uma variante. */
export function fakeFixturePath(variant: string): string {
  if (!isFakeVariant(variant)) throw new Error(`variante desconhecida do site de teste: ${variant}`);
  return fileURLToPath(new URL(`../../fixtures/fake/${variant}.html`, import.meta.url));
}

const STEP_TIMEOUT_MS = 5_000;
const CONFIRMED = /Candidatura recebida/;

export interface FakeSiteOptions {
  /** Espera pelo resultado de um clique de envio (e, depois de um portão resolvido, antes de clicar de novo). */
  submitMs?: number;
}

/**
 * Atende vagas da fonte `fake`. A variante do formulário vem de `?variant=` na URL da vaga; sem ela, `form`. O alvo é
 * sempre em `FAKE_SITE_ORIGIN` (mesmo caminho e busca da URL da vaga), o único endereço que o navegador do site de
 * teste serve: a fonte falsa publica as vagas em outro host (`https://example.com/jobs/fake-N`).
 */
export function createFakeSite(options: FakeSiteOptions = {}): ApplySite {
  const submitMs = options.submitMs ?? STEP_TIMEOUT_MS;
  const submitButton = (page: Page) => page.locator('#submit');
  const humanGate = async (page: Page): Promise<HumanGate | null> =>
    ((await page.locator('#captcha-gate:visible').count()) ? 'captcha' : null);
  return {
    id: 'fake',
    needsLogin: false,

    match(job: ApplyJob): ApplyTarget | null {
      if (job.source !== 'fake') return null;
      let variant = 'form';
      let url = `${FAKE_SITE_ORIGIN}/jobs/${encodeURIComponent(job.externalId)}`;
      try {
        const parsed = new URL(job.url);
        variant = parsed.searchParams.get('variant') ?? 'form';
        if (!isFakeVariant(variant)) {
          // Variante desconhecida: a URL acompanha a variante realmente usada.
          variant = 'form';
          parsed.searchParams.set('variant', variant);
        }
        url = new URL(`${parsed.pathname}${parsed.search}`, FAKE_SITE_ORIGIN).toString();
      } catch { /* url inválida: variante padrão */ }
      return { site: 'fake', url, ref: { variant } };
    },

    async sessionState() {
      return 'logged_in';
    },

    async open(page, target) {
      forgetSubmitClick(page);
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if (await page.locator('#closed').count()) return { kind: 'unavailable', reason: 'closed' };
      if (await page.locator('#already-applied').count()) return { kind: 'unavailable', reason: 'already_applied' };
      return { kind: 'form' };
    },

    readStep: (page) => siteLayoutErrors('site de teste', async (): Promise<StepRead> => {
      const step = page.locator('form[data-fake-form] .step:not([hidden])').first();
      if (!(await step.count())) throw new SiteLayoutError('formulário do site de teste não encontrado');
      const questions = await step.locator('.field').evaluateAll((fields): Question[] =>
        fields.map((field) => {
          const input = field.querySelector('input, textarea, select') as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
          if (!input) return { id: '', label: '', help: '', kind: 'text', options: [], required: false, maxLength: null };
          const label = field.querySelector('label')?.textContent?.trim() ?? '';
          const tag = input.tagName.toLowerCase();
          const type = (input as HTMLInputElement).type;
          let kind: QuestionKind = 'text';
          if (tag === 'textarea') kind = 'longtext';
          else if (tag === 'select') kind = (input as HTMLSelectElement).multiple ? 'multiselect' : 'select';
          else if (type === 'file') kind = 'file';
          else if (type === 'number') kind = 'number';
          else if (type === 'checkbox') kind = 'boolean';
          else if (type === 'date') kind = 'date';
          const options = tag === 'select'
            ? Array.from((input as HTMLSelectElement).options).map((o) => o.textContent?.trim() ?? '').filter(Boolean)
            : [];
          const max = (input as HTMLInputElement).maxLength;
          return {
            id: input.getAttribute('name') ?? '',
            label,
            help: field.querySelector('.help')?.textContent?.trim() ?? '',
            kind,
            options,
            required: input.hasAttribute('required'),
            maxLength: max > 0 ? max : null,
          };
        }));
      if (!questions.length || questions.some((q) => !q.id || !q.label)) {
        throw new SiteLayoutError('campos do formulário do site de teste não reconhecidos');
      }
      const isLast = (await page.locator('#next:visible').count()) === 0;
      return { questions, isLast };
    }),

    fillStep: (page, answers, files) => siteLayoutErrors('site de teste', async () => {
      const step = page.locator('form[data-fake-form] .step:not([hidden])').first();
      for (const answer of answers) {
        const input = step.locator(`[name="${answer.questionId}"]`);
        if (!(await input.count())) continue; // a resposta é de outra etapa
        const type = await input.evaluate((el) => (el as HTMLInputElement).type);
        if (type === 'file') {
          await input.setInputFiles(files.resumePath);
          continue;
        }
        const { value } = answer;
        if (value === null || value === '') continue;
        if (type === 'checkbox') await input.setChecked(value === true || value === 'true');
        else if (type.startsWith('select')) await input.selectOption(Array.isArray(value) ? value : String(value));
        else await input.fill(String(value));
      }
    }),

    async next(page) {
      await page.locator('#next').click({ timeout: STEP_TIMEOUT_MS });
    },

    async submit(page) {
      return submitAndWait(page, {
        site: 'site de teste',
        submitButton: submitButton(page),
        formOnScreen: () => buttonOnScreen(submitButton(page)),
        confirmationText: async () => {
          const shown = page.locator('#confirmation:visible');
          if (!(await shown.count())) return null;
          const text = squash((await shown.first().textContent()) ?? '');
          return CONFIRMED.test(text) ? text : null;
        },
        fieldErrorVisible: () => fieldErrorOnScreen(page),
        refused: async () => (await page.locator('#error').count()) > 0,
        gate: () => humanGate(page),
        stepMs: STEP_TIMEOUT_MS,
        submitMs,
      });
    },

    humanGate,

    async discard(page) {
      forgetSubmitClick(page);
      await page.goto('about:blank');
    },
  };
}
