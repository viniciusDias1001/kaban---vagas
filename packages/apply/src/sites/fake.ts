import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import type { Question, QuestionKind } from '@kv/shared';
import { SiteLayoutError, SubmitRejectedError } from '../types';
import type { ApplyJob, ApplySite, ApplyTarget, HumanGate, StepRead } from '../types';

export const FAKE_SITE_ORIGIN = 'http://apply.fake.test';

const VARIANTS = ['form', 'two-steps', 'closed', 'already-applied', 'captcha', 'rejected', 'broken'] as const;
type FakeVariant = (typeof VARIANTS)[number];

export function isFakeVariant(v: string): v is FakeVariant {
  return (VARIANTS as readonly string[]).includes(v);
}

/** Caminho absoluto do HTML de uma variante. */
export function fakeFixturePath(variant: string): string {
  return fileURLToPath(new URL(`../../fixtures/fake/${variant}.html`, import.meta.url));
}

const STEP_TIMEOUT_MS = 5_000;

/** Atende vagas da fonte `fake`. A variante do formulário vem de `?variant=` na URL da vaga; sem ela, `form`. */
export function createFakeSite(): ApplySite {
  return {
    id: 'fake',
    needsLogin: false,

    match(job: ApplyJob): ApplyTarget | null {
      if (job.source !== 'fake') return null;
      let variant = 'form';
      try {
        variant = new URL(job.url).searchParams.get('variant') ?? 'form';
      } catch { /* url inválida: variante padrão */ }
      if (!isFakeVariant(variant)) variant = 'form';
      return { site: 'fake', url: job.url, ref: { variant } };
    },

    async sessionState() {
      return 'logged_in';
    },

    async open(page, target) {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if (await page.locator('#closed').count()) return { kind: 'unavailable', reason: 'closed' };
      if (await page.locator('#already-applied').count()) return { kind: 'unavailable', reason: 'already_applied' };
      return { kind: 'form' };
    },

    async readStep(page): Promise<StepRead> {
      const step = page.locator('form[data-fake-form] .step:not([hidden])').first();
      if (!(await step.count())) throw new SiteLayoutError('formulário do site de teste não encontrado');
      const questions = await step.locator('.field').evaluateAll((fields): Question[] =>
        fields.map((field) => {
          const input = field.querySelector('input, textarea, select') as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
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
    },

    async fillStep(page, answers, files) {
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
    },

    async next(page) {
      await page.locator('#next').click({ timeout: STEP_TIMEOUT_MS });
    },

    async submit(page) {
      await page.locator('#submit:visible').click({ timeout: STEP_TIMEOUT_MS });
      const outcome = page.locator('#confirmation, #error').first();
      try {
        await outcome.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      } catch {
        throw new SiteLayoutError('o site de teste não respondeu ao envio');
      }
      if (await page.locator('#error').count()) throw new SubmitRejectedError('o site de teste recusou o envio');
      const text = ((await page.locator('#confirmation').textContent()) ?? '').trim();
      if (!/Candidatura recebida/.test(text)) throw new SiteLayoutError('confirmação não reconhecida');
      return { confirmation: text };
    },

    async humanGate(page: Page): Promise<HumanGate | null> {
      return (await page.locator('#captcha-gate:visible').count()) ? 'captcha' : null;
    },

    async discard(page) {
      await page.goto('about:blank');
    },
  };
}
