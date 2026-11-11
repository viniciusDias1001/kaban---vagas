import type { Page } from '@playwright/test';

/**
 * Junta erros de console, exceções da página, requisições que falharam e respostas 4xx/5xx. Nenhum 404 é
 * tolerado: as imagens do app (logo.png, empty.png, header-bg.jpg) existem em apps/web/public.
 *
 * `state.navigating`: ligue em volta de um `page.reload()`, que aborta as requisições em andamento.
 * `ignoreAborted`: URLs cuja requisição o navegador "aborta" de propósito, como um link que vira download
 * (a navegação é cancelada quando a resposta chega como anexo; o arquivo é baixado normalmente).
 */
export function collectProblems(page: Page, opts: { ignoreAborted?: (url: string) => boolean } = {}) {
  const problems: string[] = [];
  const state = { navigating: false };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    problems.push(`console.error: ${msg.text()} (${msg.location().url})`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    const aborted = req.failure()?.errorText === 'net::ERR_ABORTED';
    // Recarregar a página aborta as requisições em andamento; isso não é falha do app.
    if (state.navigating && aborted) return;
    if (aborted && opts.ignoreAborted?.(req.url())) return;
    problems.push(`requestfailed: ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`);
  });
  page.on('response', (res) => {
    if (res.status() < 400) return;
    problems.push(`http ${res.status()}: ${res.request().method()} ${res.url()}`);
  });
  return { problems, state };
}
