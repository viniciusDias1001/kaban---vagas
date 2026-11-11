import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Imagens ainda não geradas (Task 19 do plano): o 404 delas é esperado por enquanto. (No Vite dev o
 * pedido cai no fallback de SPA e volta 200; o 404 aparece quando o web é servido já buildado.)
 */
const MISSING_ASSETS = new Set(['/logo.png', '/empty.png', '/header-bg.jpg']);
const isMissingAsset = (url: string) => {
  try {
    return MISSING_ASSETS.has(new URL(url).pathname);
  } catch {
    return false;
  }
};

/** Junta erros de console, exceções da página e requisições que falharam, fora os 404 esperados. */
function collectProblems(page: Page) {
  const problems: string[] = [];
  const state = { navigating: false };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (isMissingAsset(msg.location().url)) return;
    problems.push(`console.error: ${msg.text()} (${msg.location().url})`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    // Recarregar a página aborta as requisições em andamento; isso não é falha do app.
    if (state.navigating && req.failure()?.errorText === 'net::ERR_ABORTED') return;
    problems.push(`requestfailed: ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`);
  });
  page.on('response', (res) => {
    if (res.status() < 400 || isMissingAsset(res.url())) return;
    problems.push(`http ${res.status()}: ${res.request().method()} ${res.url()}`);
  });
  return { problems, state };
}

/** Só grava screenshots quando E2E_SCREENSHOT_DIR está definida (inspeção visual manual). */
async function snapshot(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(800); // deixa as animações de entrada terminarem
  await page.screenshot({ path: join(dir, name), fullPage: true });
}

test('profile search fills the board and a moved card persists', async ({ page }) => {
  const { problems, state } = collectProblems(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Perfis de busca' }).click();
  await page.getByPlaceholder('React Pleno remoto').fill('E2E');
  await page.getByPlaceholder('react, node, typescript').fill('react');
  await page.getByLabel('Fake', { exact: true }).check();
  await page.getByRole('button', { name: 'Salvar perfil' }).click();
  await expect(page.getByTestId('profile')).toHaveCount(1);

  await page.getByRole('button', { name: 'Buscar agora' }).click();
  await expect(page.getByRole('status')).toContainText('Busca enfileirada em 1 fonte');
  // O worker verifica a fila a cada 5 s (e pode ainda estar subindo): espera a vaga existir na API
  // antes de ir ao quadro, que só refaz a consulta a cada 15 s.
  await expect
    .poll(async () => ((await (await page.request.get('/api/jobs')).json()) as unknown[]).length, { timeout: 60_000 })
    .toBe(1);
  await page.getByRole('button', { name: 'Quadro' }).click();

  const discovered = page.getByTestId('column-descobertas');
  const selected = page.getByTestId('column-selecionadas');
  const card = discovered.getByTestId('job-card').filter({ hasText: 'Fake React Developer' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  // O perfil filtra por `react`: "Fake Node Engineer" não pode entrar.
  await expect(page.getByTestId('job-card')).toHaveCount(1);

  const from = (await card.boundingBox())!;
  const to = (await selected.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 15 });
  await page.mouse.up();

  await expect(selected.getByTestId('job-card')).toHaveCount(1);
  await expect(discovered.getByTestId('job-card')).toHaveCount(0);
  // Soltar o card não pode contar como clique nele (abriria o detalhe).
  await expect(page.getByRole('dialog')).toHaveCount(0);

  state.navigating = true;
  await page.reload();
  state.navigating = false;
  const moved = page.getByTestId('column-selecionadas').getByTestId('job-card');
  await expect(moved).toHaveCount(1);
  await expect(moved).toContainText('Fake React Developer');
  await expect(page.getByTestId('column-descobertas').getByTestId('job-card')).toHaveCount(0);
  await snapshot(page, 'board-selecionadas.png');

  await moved.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Descobertas → Selecionadas');
  await expect(drawer.getByRole('heading', { name: 'Fake React Developer' })).toBeVisible();
  await snapshot(page, 'drawer.png');

  await drawer.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  expect(problems, 'erros de console, exceções ou requisições com falha').toEqual([]);
});
