import type { Page } from 'playwright';

export const SITE_TIMEOUTS = { pageMs: 30_000, stepMs: 15_000, submitMs: 30_000 } as const;

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Igual, ignorando caixa e espaços repetidos; nada mais (acento e pontuação contam). */
export function sameText(a: string, b: string): boolean {
  return squash(a) === squash(b);
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
