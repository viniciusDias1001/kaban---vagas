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
  forgetSubmitClick(page);
  if (/^https?:/i.test(page.url())) {
    await page.evaluate(() => {
      try { localStorage.clear(); } catch { /* origem sem armazenamento */ }
      try { sessionStorage.clear(); } catch { /* idem */ }
    });
  }
  await page.goto('about:blank');
}

/** Rede, navegação e navegador fechado: passageiros (o motor relança e a fila tenta de novo mais tarde). */
const TRANSIENT = /net::ERR_|navigat|execution context was destroyed|frame was detached|has been closed|target closed|browser closed|crash|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i;
/** Estado de elemento que o roteiro não esperava: a página mudou de forma. */
const ELEMENT_STATE = new RegExp([
  'element is not', 'not a checkbox or radio button', 'did not change its state', 'strict mode violation',
  'can only accept single file', 'not attached to the dom', 'did not find some options', 'outside of the viewport',
  'cannot set input files', 'not an? <',
].join('|'), 'i');

/**
 * Erro do Playwright que diz que a página não é o que o roteiro espera: espera esgotada (`errors.TimeoutError`) ou
 * elemento em estado inesperado. Erro de rede, de navegação ou de navegador fechado não é.
 */
export function isLayoutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Só a primeira linha: o "Call log" que o Playwright acrescenta cita navegações agendadas em qualquer espera.
  const first = error.message.split(/\r?\n/)[0] ?? '';
  if (TRANSIENT.test(first)) return false;
  return error.name === 'TimeoutError' || ELEMENT_STATE.test(first);
}

/**
 * Roda a leitura ou o preenchimento de uma etapa transformando as falhas de layout do Playwright em
 * `SiteLayoutError` ("formulário não reconhecido"); o resto passa como veio.
 */
export async function siteLayoutErrors<T>(site: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SiteLayoutError || error instanceof SubmitRejectedError || !isLayoutFailure(error)) throw error;
    const line = ((error as Error).message.split(/\r?\n/)[0] ?? '').trim().slice(0, 200);
    throw new SiteLayoutError(`${site}: o formulário não respondeu como esperado (${line})`, { cause: error });
  }
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

/**
 * Campo de cidade com sugestões: digita, espera a lista por até 3 s e clica na que é igual ao valor ou começa por ele.
 * `listOf` acha a lista depois da digitação: alguns sites só a criam então.
 */
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
  /** O site disse, com o formulário na tela, que recusou o envio (sem portão para resolver). Opcional. */
  refused?(): Promise<boolean>;
  /**
   * Depois de um clique anterior nesta página: o envio pode estar em andamento (resposta de captcha preenchida, botão
   * desativado, ocupado ou com outro texto). Sem este campo, `submissionMayBeInFlight` decide.
   */
  inFlight?(): Promise<boolean>;
  stepMs: number;
  submitMs: number;
}

/** Páginas em que o envio já foi clicado desde a última abertura do formulário, com o texto do botão naquele clique. */
const clickedPages = new WeakMap<Page, { buttonText: string | null }>();

/** Esquece o clique de envio desta página: cada roteiro chama ao abrir um formulário e ao sair dele. */
export function forgetSubmitClick(page: Page): void {
  clickedPages.delete(page);
}

/** O envio já foi clicado nesta página desde a última abertura do formulário. */
export function submitClicked(page: Page): boolean {
  return clickedPages.has(page);
}

const CAPTCHA_RESPONSE = 'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="g-recaptcha-response"], '
  + 'input[name="h-captcha-response"], input[name="cf-turnstile-response"]';

async function buttonText(button: Locator): Promise<string | null> {
  try {
    return squash((await button.first().textContent({ timeout: 1_000 })) ?? '');
  } catch {
    return null;
  }
}

/**
 * Sinais de que um envio já clicado ainda pode estar indo: alguma resposta de captcha preenchida (o retorno do
 * captcha costuma continuar o envio sozinho), o botão desativado, `aria-disabled`/`aria-busy`, ou com texto
 * diferente do que tinha no clique ("Submitting..."). Na dúvida (a leitura falhou), é que pode.
 */
export async function submissionMayBeInFlight(page: Page, button: Locator, textAtClick: string | null): Promise<boolean> {
  try {
    const answered = await page.evaluate((selector) => Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(selector))
      .some((field) => field.value.trim() !== ''), CAPTCHA_RESPONSE);
    if (answered) return true;
    const first = button.first();
    if (!(await first.isEnabled({ timeout: 1_000 }))) return true;
    if ((await first.getAttribute('aria-disabled', { timeout: 1_000 })) === 'true') return true;
    if ((await first.getAttribute('aria-busy', { timeout: 1_000 })) === 'true') return true;
    return textAtClick !== null && (await buttonText(button)) !== textAtClick;
  } catch {
    return true;
  }
}

type Outcome = { confirmation: string } | null;

/**
 * Espera até `deadline` o resultado de um clique: confirmação com o formulário fora é sucesso; portão é
 * `SubmitRejectedError` na hora; recusa do site também; erro de campo visível é `SiteLayoutError`. Null: nada decidiu.
 */
async function awaitOutcome(o: SubmitWait, deadline: number): Promise<Outcome> {
  while (Date.now() < deadline) {
    try {
      if (await o.gate()) throw new SubmitRejectedError('apareceu um portão depois do clique no envio');
      const confirmation = await o.confirmationText();
      const onScreen = await o.formOnScreen();
      if (confirmation && !onScreen) return { confirmation };
      if (onScreen && (await o.fieldErrorVisible())) throw new SiteLayoutError(`${o.site}: erro em um campo do formulário`);
      if (onScreen && o.refused && (await o.refused())) throw new SubmitRejectedError(`${o.site}: o site recusou o envio`);
    } catch (error) {
      if (error instanceof SiteLayoutError || error instanceof SubmitRejectedError) throw error;
      // A página está trocando de documento; tenta de novo no próximo ciclo.
    }
    await sleep(150);
  }
  return null;
}

/** Clica uma vez, guardando antes a marca de clique da página, e espera o resultado até `submitMs`. */
async function clickAndWait(page: Page, o: SubmitWait): Promise<{ confirmation: string }> {
  const text = o.inFlight ? null : await buttonText(o.submitButton);
  // A marca vem antes do clique: um clique que falha no meio pode já ter chegado ao site.
  clickedPages.set(page, { buttonText: text });
  await o.submitButton.first().click({ timeout: o.stepMs });
  const outcome = await awaitOutcome(o, Date.now() + o.submitMs);
  if (outcome) return outcome;
  const confirmation = await o.confirmationText().catch(() => null);
  const onScreen = await o.formOnScreen().catch(() => false);
  if (confirmation && !onScreen) return { confirmation };
  if (onScreen) {
    if (await o.fieldErrorVisible()) throw new SiteLayoutError(`${o.site}: erro em um campo do formulário`);
    throw new SubmitRejectedError(`${o.site}: o envio não foi confirmado e o formulário não aponta erro`);
  }
  throw new SiteLayoutError('o formulário saiu da tela sem confirmação: confira no site se a candidatura foi enviada');
}

/**
 * Envio conservador, igual em todos os sites sem login. Confirmação já na tela com o formulário fora: devolve sem clicar.
 *
 * Primeira chamada desde a abertura do formulário: clica uma vez e espera `submitMs`; portão é `SubmitRejectedError`
 * na hora; erro de campo visível é `SiteLayoutError`; só há sucesso com o formulário fora da tela E um sinal de
 * confirmação.
 *
 * Chamada depois de um clique nesta página (o motor chama de novo depois de um portão resolvido pelo dono): nunca
 * clica na hora. Espera até `submitMs` por confirmação, formulário fora ou navegação (o retorno do captcha costuma
 * continuar o primeiro envio sozinho). Passado esse tempo, só clica de novo com o formulário na tela, sem portão, sem
 * erro de campo, sem recusa e sem nenhum sinal de envio em andamento (`inFlight`). Com sinal de envio em andamento,
 * não clica: `SiteLayoutError`, que o motor transforma em "confira no site".
 */
export async function submitAndWait(page: Page, o: SubmitWait): Promise<{ confirmation: string }> {
  const done = await o.confirmationText();
  if (done && !(await o.formOnScreen())) return { confirmation: done };
  const earlier = clickedPages.get(page);
  if (!earlier) {
    if (!(await o.formOnScreen())) {
      throw new SiteLayoutError(`o formulário (${o.site}) não está na tela: confira no site se a candidatura foi enviada`);
    }
    return clickAndWait(page, o);
  }

  const settled = await awaitOutcome(o, Date.now() + o.submitMs);
  if (settled) return settled;
  const confirmation = await o.confirmationText().catch(() => null);
  const onScreen = await o.formOnScreen().catch(() => false);
  if (confirmation && !onScreen) return { confirmation };
  if (!onScreen) {
    throw new SiteLayoutError('o formulário saiu da tela sem confirmação depois do envio: confira no site se a candidatura foi enviada');
  }
  if (await o.fieldErrorVisible()) throw new SiteLayoutError(`${o.site}: erro em um campo do formulário`);
  if (await o.gate()) throw new SubmitRejectedError('o portão continua na tela depois do clique no envio');
  if (o.refused && (await o.refused())) throw new SubmitRejectedError(`${o.site}: o site recusou o envio`);
  const busy = o.inFlight ? await o.inFlight() : await submissionMayBeInFlight(page, o.submitButton, earlier.buttonText);
  if (busy) {
    throw new SiteLayoutError(`${o.site}: o primeiro envio pode estar em andamento, então não cliquei de novo`);
  }
  return clickAndWait(page, o);
}
