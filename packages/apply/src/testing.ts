import type { Page } from 'playwright';

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** Pela extensão do arquivo servido: o navegador não aplica folha de estilo nem roda script com tipo errado. */
function contentTypeFor(file: string): string {
  const ext = /\.[a-z0-9]+$/i.exec(file)?.[0].toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'text/html; charset=utf-8';
}

/**
 * Abre o Chromium do Playwright, sem janela, com a rede cortada: cada URL de `routes` responde com o
 * arquivo indicado (caminho absoluto) e qualquer outra requisição é abortada. A chave casa com a URL
 * completa; na falta, com a URL sem a query.
 */
export async function openFixture(routes: Record<string, string>): Promise<{ page: Page; close(): Promise<void> }> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'pt-BR' });
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const noQuery = url.split(/[?#]/)[0];
    const file = routes[url] ?? routes[noQuery];
    if (!file) return route.abort();
    return route.fulfill({ path: file, contentType: contentTypeFor(file) });
  });
  const page = await context.newPage();
  return { page, close: () => browser.close() };
}
