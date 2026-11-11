import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';
import { SAMPLE_RESUME_TEXT } from '../../../packages/ai/src/testing';
import { extractResumeText } from '../../../packages/resume/src/extract';
import { makeTextPdf } from '../../../packages/resume/src/testing';
import { collectProblems } from './problems';

/**
 * IA de perfil de ponta a ponta, com o provedor falso e a fonte falsa: configurar a IA pela aba
 * Configurações (o servidor sobe SEM provedor; `AI_ALLOW_FAKE=1` no playwright.config só libera a opção),
 * gravar uma chave e vê-la só pelos quatro últimos caracteres, enviar currículo, ver a nota no card,
 * abrir a análise, adaptar o currículo, baixar o PDF e ler o texto dele.
 * Nenhuma chamada sai da máquina. O currículo é de uma pessoa fictícia, gerado aqui mesmo.
 *
 * Roda depois de board.spec.ts (ordem alfabética) e aproveita a vaga que ele deixou no quadro; sozinho,
 * cria o perfil de busca e dispara a busca pela API.
 */

const JOB_TITLE = 'Fake React Developer';
/** Chave fictícia: nunca é usada em chamada nenhuma (o provedor escolhido no teste é o falso). */
const E2E_KEY = 'sk-e2e-chave-ficticia-1234';
const COLUMNS = ['descobertas', 'selecionadas', 'aplicada', 'entrevista', 'oferta', 'arquivada'];
const REVISED_SUMMARY = 'Resumo revisado por mim, sem números novos.';

/** Só grava screenshots quando E2E_SCREENSHOT_DIR está definida (inspeção visual manual). */
async function snapshot(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, name) });
}

async function ensureJob(page: Page) {
  const jobs = async () => (await (await page.request.get('/api/jobs')).json()) as { title: string }[];
  if ((await jobs()).some((j) => j.title === JOB_TITLE)) return;
  const created = await page.request.post('/api/profiles', {
    data: { name: 'E2E IA', stacks: ['react'], levels: [], maxAgeDays: 7, regions: [], sources: ['fake'] },
  });
  expect(created.status()).toBe(201);
  const run = await page.request.post('/api/runs', { data: { profileId: (await created.json()).id } });
  expect(run.status()).toBe(202);
  await expect.poll(async () => (await jobs()).some((j) => j.title === JOB_TITLE), { timeout: 60_000 }).toBe(true);
}

/**
 * Guarda o corpo de TODA resposta que a página recebe (API, módulos do Vite, o próprio PDF), para conferir no
 * fim que a chave gravada não voltou em nenhuma. A chave só pode viajar em um sentido: no corpo do PUT.
 */
function captureResponseBodies(page: Page) {
  const pending: Promise<{ url: string; body: string }>[] = [];
  const onResponse = (res: Response) => {
    pending.push(
      res.text().then(
        (body) => ({ url: `${res.request().method()} ${res.url()}`, body }),
        // Redirecionamento, 204, download: sem corpo legível pela página.
        () => ({ url: `${res.request().method()} ${res.url()}`, body: '' }),
      ),
    );
  };
  page.on('response', onResponse);
  return {
    async all() {
      page.off('response', onResponse);
      return Promise.all(pending);
    },
  };
}

/** Os blocos de chave vêm fechados (a menos que o provedor deles seja o escolhido): abre o do provedor pedido. */
async function openKeyBlock(page: Page, provider: string) {
  const header = page.getByTestId(`key-${provider}`).locator('> button');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}

/** O aviso flutuante aparece inteiro acima da barra fixa de salvar. */
async function expectToastAboveBar(page: Page, text: string, barTestId: string) {
  const toast = page.getByTestId('toast-region').getByRole('status');
  await expect(toast).toContainText(text);
  // A região sobe com uma transição curta quando a barra aparece: espera a posição final.
  await expect
    .poll(async () => {
      const t = await toast.boundingBox();
      const bar = await page.getByTestId(barTestId).boundingBox();
      return t !== null && bar !== null && t.y + t.height <= bar.y;
    })
    .toBe(true);
}

test('settings from the screen, write-only key, resume upload, score, analysis, tailored resume and PDF text', async ({ page }) => {
  test.setTimeout(300_000);
  // O download do PDF é uma navegação que o navegador cancela ao receber um anexo: não é falha do app.
  const { problems } = collectProblems(page, { ignoreAborted: (url) => url.endsWith('/tailored.pdf') });
  const responses = captureResponseBodies(page);

  await page.goto('/');
  await ensureJob(page);

  // --- Sem configuração: Meu perfil avisa e leva às Configurações --------------------------------
  await page.getByRole('button', { name: 'Meu perfil' }).click();
  await expect(page.getByTestId('ai-not-configured')).toBeVisible();
  await page.getByTestId('go-to-settings').click();

  // --- Configurações: sem provedor escolhido, todos os blocos de chave começam fechados -----------
  await expect(page.getByTestId('settings-status')).toContainText('IA não configurada');
  await expect(page.getByTestId('secret-missing')).toHaveCount(0);
  for (const provider of ['anthropic', 'openai', 'gemini']) {
    await expect(page.getByTestId(`key-${provider}`).locator('> button')).toHaveAttribute('aria-expanded', 'false');
  }
  await expect(page.getByTestId('key-input-openai')).toHaveCount(0);

  // --- A chave gravada só aparece pelos quatro últimos caracteres ----------------------------------
  await openKeyBlock(page, 'openai');
  await page.getByTestId('key-input-openai').fill(E2E_KEY);
  await page.getByTestId('key-save-openai').click();
  await expect(page.getByTestId('key-masked-openai')).toHaveText('•••• 1234');
  await expect(page.getByTestId('key-input-openai')).toHaveCount(0);
  await expectToastAboveBar(page, 'Chave de OpenAI gravada', 'settings-footer');
  expect(await page.content()).not.toContain(E2E_KEY);
  const settingsBody = await (await page.request.get('/api/settings')).text();
  expect(settingsBody).not.toContain(E2E_KEY);
  expect(settingsBody).toContain('"last4":"1234"');
  await snapshot(page, 'ai-settings-key.png');

  // --- Escolher o provedor pela tela liga a IA, sem reiniciar nada ---------------------------------
  await page.getByTestId('settings-provider').getByRole('radio', { name: 'Provedor falso (testes)' }).click();
  await expect(page.getByTestId('settings-model-fast')).toHaveValue('fake-fast');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-status')).toContainText('IA configurada');
  await expectToastAboveBar(page, 'Configurações salvas', 'settings-footer');
  await page.getByTestId('settings-test').click();
  await expect(page.getByTestId('settings-test-result')).toHaveAttribute('data-outcome', 'ok');
  await expect(page.getByTestId('settings-test-result')).toContainText('funcionando');

  // --- Meu perfil: aviso de privacidade, upload e perfil estruturado -------------------------------
  await page.getByRole('button', { name: 'Meu perfil' }).click();
  await expect(page.getByTestId('ai-not-configured')).toHaveCount(0);

  const upload = page.getByTestId('resume-upload-pt-BR');
  await expect(page.getByTestId('privacy-notice')).toBeVisible();
  await expect(upload).toBeDisabled();
  await page.getByTestId('privacy-accept').check();
  await expect(upload).toBeEnabled();

  await upload.setInputFiles({
    name: 'curriculo-ficticio.pdf',
    mimeType: 'application/pdf',
    buffer: await makeTextPdf(SAMPLE_RESUME_TEXT),
  });
  await expect(page.getByTestId('resume-file-pt-BR')).toContainText('curriculo-ficticio.pdf');

  // O worker verifica a fila a cada 5 s; o perfil aparece sozinho quando a extração termina.
  const editor = page.getByTestId('profile-editor-pt-BR');
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(editor.getByLabel('Nome')).toHaveValue('Maria Exemplo da Silva');
  await expect(page.getByTestId('profile-summary-pt-BR')).toHaveValue(/Pessoa fictícia para testes/);
  await expect(page.getByTestId('profile-origin-pt-BR')).toContainText('extraído');
  await snapshot(page, 'ai-profile.png');

  // --- Quadro: nota e idioma no card, sem nenhuma ação ---------------------------------------------
  await page.getByRole('button', { name: 'Quadro' }).click();
  const card = page.getByTestId('job-card').filter({ hasText: JOB_TITLE });
  // Perfil com React, vaga com React: o provedor falso dá 70.
  await expect(card.getByTestId('job-score')).toHaveText('70', { timeout: 90_000 });
  await expect(card.getByTestId('job-language')).toHaveText('PT');
  // Ordenar por nota só é oferecido onde há cards.
  for (const column of COLUMNS) {
    const cards = await page.getByTestId(`column-${column}`).getByTestId('job-card').count();
    await expect(page.getByTestId(`sort-${column}`)).toHaveCount(cards > 0 ? 1 : 0);
  }
  await snapshot(page, 'ai-board.png');

  // --- Drawer: análise da vaga ----------------------------------------------------------------------
  await card.click();
  const drawer = page.getByRole('dialog');
  // Vaga em português: o título não tem tradução, então aparece uma vez só, sem a linha do original.
  await expect(drawer.getByRole('heading', { name: JOB_TITLE })).toBeVisible();
  await expect(drawer.getByTestId('job-original-title')).toHaveCount(0);
  const analysis = drawer.getByTestId('ai-analysis');
  await expect(analysis).toContainText('Experiência com React', { timeout: 60_000 });
  await expect(analysis).toContainText('Conte sobre um projeto recente.');

  // --- Currículo adaptado: gerar, revisar, baixar ---------------------------------------------------
  await drawer.getByTestId('tailor-button').click();
  const tailored = drawer.getByTestId('tailored-editor');
  await expect(tailored).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByTestId('tailored-summary')).toHaveValue(/Pessoa fictícia para testes/);
  // Empresa, cargo e datas vêm do perfil e não são editáveis.
  await expect(tailored).toContainText('Empresa Fictícia Ltda');
  await expect(drawer.getByTestId('tailored-pdf-warning')).toHaveCount(0);

  await drawer.getByTestId('tailored-summary').fill(REVISED_SUMMARY);
  await drawer.getByTestId('tailored-save').click();
  await expect(drawer.getByTestId('tailored-save')).toBeDisabled();
  await expect(tailored).toContainText('Salvo.');
  await expect(drawer.getByTestId('tailored-warnings')).toHaveCount(0);
  await snapshot(page, 'ai-tailored.png');

  const [download] = await Promise.all([page.waitForEvent('download'), drawer.getByTestId('tailored-download').click()]);
  expect(download.suggestedFilename()).toMatch(/^curriculo-vaga-\d+\.pdf$/);
  await expect(drawer.getByTestId('tailored-pdf-error')).toHaveCount(0);
  const pdf = readFileSync(await download.path());
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

  // O texto do PDF, lido com o mesmo extrator que o app usa nos currículos enviados: o nome, o resumo revisado
  // e os dados copiados do perfil estão lá; nada que não esteja no perfil nem no resumo aparece.
  const extracted = await extractResumeText(pdf, 'pdf');
  expect(extracted.ok, 'o PDF baixado tem texto extraível').toBe(true);
  const text = (extracted.ok ? extracted.text : '').replace(/\s+/g, ' ');
  expect(text).toContain('Maria Exemplo da Silva');
  expect(text).toContain(REVISED_SUMMARY);
  expect(text).toContain('Empresa Fictícia Ltda');
  expect(text).toContain('Reduzi o tempo de build em 40% com a migração para Vite');
  expect(text).not.toContain('Pessoa fictícia para testes'); // o resumo antigo foi substituído
  for (const invented of ['Empresa Inventada', 'Kubernetes', 'Fake Corp']) expect(text).not.toContain(invented);
  expect(text).not.toContain(E2E_KEY);

  // --- Configurações: o gasto aparece (zero com o provedor falso) e a chave só sai com confirmação ---
  await drawer.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Configurações' }).click();
  await expect(page.getByTestId('settings-usage')).toBeVisible();
  // Provedor falso em uso: os blocos de chave voltam fechados; o cabeçalho continua dizendo o estado.
  await expect(page.getByTestId('key-openai').locator('> button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('key-openai')).toContainText('chave gravada');
  await openKeyBlock(page, 'openai');
  await expect(page.getByTestId('key-masked-openai')).toHaveText('•••• 1234');

  // Um clique não remove: abre a confirmação, que diz de qual provedor é a chave. Cancelar mantém a chave.
  await page.getByTestId('key-remove-openai').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Remover a chave de API de OpenAI?');
  await expect(confirm).toContainText('param de funcionar');
  await snapshot(page, 'ai-remove-key.png');
  await page.getByTestId('key-remove-dialog-openai-cancel').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('key-masked-openai')).toHaveText('•••• 1234');

  await page.getByTestId('key-remove-openai').click();
  await page.getByTestId('key-remove-dialog-openai-confirm').click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByTestId('key-masked-openai')).toHaveCount(0);
  await expect(page.getByTestId('key-input-openai')).toBeVisible();

  // --- A chave não vazou: nem na página, nem no armazenamento do navegador, nem em resposta nenhuma ----
  expect(await page.content()).not.toContain(E2E_KEY);
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href, document.cookie]));
  expect(stored).not.toContain(E2E_KEY);
  const bodies = await responses.all();
  expect(bodies.length).toBeGreaterThan(20);
  expect(bodies.some((r) => r.url.includes('/api/settings') && r.body.includes('"last4":"1234"'))).toBe(true);
  expect(bodies.filter((r) => r.body.includes(E2E_KEY)).map((r) => r.url), 'respostas que trazem a chave').toEqual([]);

  expect(problems, 'erros de console, exceções ou requisições com falha').toEqual([]);
});
