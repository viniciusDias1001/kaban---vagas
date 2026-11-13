import type { Locator, Page } from 'playwright';
import { SiteLayoutError, SubmitRejectedError } from '../types';
import type { HumanGate } from '../types';

export const SITE_TIMEOUTS = { pageMs: 30_000, stepMs: 15_000, submitMs: 30_000 } as const;

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Igual, ignorando caixa e espaços repetidos; nada mais (acento e pontuação contam). */
export function sameText(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/** A opção oferecida igual a `wanted` por `sameText`, ou `null`. Nunca aproxima. */
export function matchOption(options: string[], wanted: string): string | null {
  return options.find((option) => sameText(option, wanted)) ?? null;
}

/** Rótulos de campo de código de verificação, em português e em inglês. */
const CODE_LABEL = /(verification|security) code|código de (verificação|segurança)/i;

/**
 * Só desafio visível na tela é portão. O script carregado, o `textarea` de resposta e o selo invisível estão em
 * toda página e não contam.
 */
// Os corpos de page.evaluate não declaram função nomeada: o tsx a envolve em __name, que não existe na página.
export function visibleCaptcha(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const answered = Array.from(document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
      'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="g-recaptcha-response"], input[name="h-captcha-response"]',
    )).some((field) => field.value.trim() !== '');
    return Array.from(document.querySelectorAll('iframe')).some((frame) => {
      const src = frame.getAttribute('src') ?? '';
      const challenge = (/recaptcha/i.test(src) && src.includes('/bframe')) || (/hcaptcha/i.test(src) && src.includes('frame=challenge'));
      const checkbox = !src.includes('size=invisible')
        && ((/recaptcha/i.test(src) && src.includes('/anchor')) || (/hcaptcha/i.test(src) && src.includes('frame=checkbox')));
      if (!challenge && !checkbox) return false;
      if (!frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const box = frame.getBoundingClientRect();
      if (challenge) return box.top >= 0 && box.top < window.innerHeight && box.width >= 100 && box.height >= 100;
      return box.width > 0 && box.height > 0 && !answered;
    });
  });
}

/** Campo visível pedindo um código de verificação ou de segurança. */
export function visibleCodePrompt(page: Page): Promise<boolean> {
  return page.evaluate((source) => {
    const pattern = new RegExp(source, 'i');
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'));
    return fields.some((field) => {
      if (!field.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const labelled = (field.getAttribute('aria-labelledby') ?? '').split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '');
      const labels = [
        ...Array.from(field.labels ?? []).map((l) => l.textContent ?? ''),
        field.closest('label')?.textContent ?? '',
        field.getAttribute('aria-label') ?? '',
        field.placeholder,
        ...labelled,
      ];
      return labels.some((label) => pattern.test(label));
    });
  }, CODE_LABEL.source);
}

/**
 * Sai do formulário sem enviar e sem deixar rascunho (decisão 12, sites sem login): esvazia o armazenamento da
 * origem em que a página está e vai para `about:blank`.
 */
export async function leaveForm(page: Page): Promise<void> {
  if (/^https?:/i.test(page.url())) {
    await page.evaluate(() => {
      try { localStorage.clear(); } catch { /* origem sem armazenamento */ }
      try { sessionStorage.clear(); } catch { /* idem */ }
    });
  }
  await page.goto('about:blank');
}

export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Portão na tela, se houver: desafio visível ou campo de código. */
export async function humanGateOf(page: Page): Promise<HumanGate | null> {
  if (await visibleCaptcha(page)) return 'captcha';
  if (await visibleCodePrompt(page)) return 'verification_code';
  return null;
}

/** O botão de envio está na tela (o formulário ainda está na página). */
export async function buttonOnScreen(button: Locator): Promise<boolean> {
  return (await button.count()) > 0 && (await button.first().isVisible());
}

/** Erro de campo visível; `extra` acrescenta seletores próprios do site. */
export async function fieldErrorOnScreen(page: Page, extra = ''): Promise<boolean> {
  const selector = ['[aria-invalid="true"]:visible', '[role="alert"]:visible', extra].filter(Boolean).join(', ');
  return (await page.locator(selector).count()) > 0;
}

/** Campo de cidade com sugestões: digita, espera a lista por até 3 s e clica na que é igual ao valor ou começa por ele. */
/** `listOf` acha a lista depois da digitação: alguns sites só a criam então. */
export async function typeWithSuggestions(control: Locator, listOf: () => Promise<Locator>, value: string): Promise<void> {
  await control.fill(value);
  const options = await listOf();
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

export interface SubmitWait {
  /** Nome do site, para as mensagens. */
  site: string;
  submitButton: Locator;
  formOnScreen(): Promise<boolean>;
  /** O texto de confirmação, ou `null`. */
  confirmationText(): Promise<string | null>;
  fieldErrorVisible(): Promise<boolean>;
  gate(): Promise<HumanGate | null>;
  stepMs: number;
  submitMs: number;
}

/**
 * Envio conservador, igual em todos os sites sem login. Confirmação já na tela com o formulário fora: devolve sem clicar.
 * Senão clica uma vez e espera `submitMs`: portão é `SubmitRejectedError` na hora; erro de campo visível é
 * `SiteLayoutError`; só há sucesso com o formulário fora da tela E um sinal de confirmação.
 */
export async function submitAndWait(page: Page, o: SubmitWait): Promise<{ confirmation: string }> {
  const done = await o.confirmationText();
  if (done && !(await o.formOnScreen())) return { confirmation: done };
  if (!(await o.formOnScreen())) {
    throw new SiteLayoutError(`o formulário (${o.site}) não está na tela: confira no site se a candidatura foi enviada`);
  }
  await o.submitButton.first().click({ timeout: o.stepMs });

  const deadline = Date.now() + o.submitMs;
  while (Date.now() < deadline) {
    try {
      if (await o.gate()) throw new SubmitRejectedError('apareceu um portão depois do clique no envio');
      const confirmation = await o.confirmationText();
      const onScreen = await o.formOnScreen();
      if (confirmation && !onScreen) return { confirmation };
      if (onScreen && (await o.fieldErrorVisible())) throw new SiteLayoutError(`${o.site}: erro em um campo do formulário`);
    } catch (error) {
      if (error instanceof SiteLayoutError || error instanceof SubmitRejectedError) throw error;
      // A página está trocando de documento; tenta de novo no próximo ciclo.
    }
    await sleep(150);
  }
  const confirmation = await o.confirmationText().catch(() => null);
  const onScreen = await o.formOnScreen().catch(() => false);
  if (confirmation && !onScreen) return { confirmation };
  if (onScreen) {
    if (await o.fieldErrorVisible()) throw new SiteLayoutError(`${o.site}: erro em um campo do formulário`);
    throw new SubmitRejectedError(`${o.site}: o envio não foi confirmado e o formulário não aponta erro`);
  }
  throw new SiteLayoutError('o formulário saiu da tela sem confirmação: confira no site se a candidatura foi enviada');
}
