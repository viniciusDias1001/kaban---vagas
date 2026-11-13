import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectProblems } from './problems';

/**
 * Candidatura automática de ponta a ponta, contra o site de teste local (FAKE_APPLY_SITE=1 no playwright.config: o
 * worker abre o formulário de `packages/apply/fixtures/fake/form.html` num Chromium sem janela e sem rede) e com o
 * provedor de IA falso. Nenhuma chamada sai da máquina.
 *
 * Roda depois de profile-ai.spec.ts (ordem alfabética) e aproveita o estado que ele deixa: provedor falso escolhido e
 * perfil enviado (o perfil responde nome, e-mail e currículo). O modo das respostas propostas pela IA fica no padrão,
 * "Com a sua aprovação".
 *
 * O formulário tem duas perguntas obrigatórias que nada no app responde sozinho:
 * - "Pretensão salarial mensal (R$)": pessoal, nunca respondida pelo modelo; chega como "sem resposta";
 * - "Anos de experiência com TypeScript": nenhuma regra a reconhece, então quem a classifica é o modelo, e o provedor
 *   falso devolve a categoria `unknown` para tudo (`apply_classify` em packages/ai/src/fake.ts). Uma pergunta `unknown`
 *   só aceita resposta salva (nunca vira fato do perfil nem texto escrito pela IA), e o casamento proposto pelo falso
 *   (`apply_match`) é sempre vazio: ela chega, de forma determinística, como "sem resposta", e não como proposta.
 * A opcional "Por que você quer trabalhar aqui?" fica em branco e nunca para a candidatura.
 */

const REACT_JOB = 'Fake React Developer';
const NODE_JOB = 'Fake Node Engineer';
const SALARY = '20000';
const YEARS = '3';
/** Esperas que dependem do worker: a varredura roda a cada 5 s com o site de teste, mas uma candidatura passa pela
 *  conferência da vaga, pelo currículo e pelo formulário; e fora do horário (a janela vai de 00:00 a 23:59) a fila
 *  espera até um minuto. */
const WORKER_WAIT = 150_000;

/** Só grava screenshots quando E2E_SCREENSHOT_DIR está definida (inspeção visual manual). */
async function snapshot(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, name) });
}

const card = (page: Page, title: string) => page.getByTestId('job-card').filter({ hasText: title });

/** O valor de um contador do quadro (os que não são botão não têm testid: acha pelo rótulo). */
function counter(page: Page, label: string): Locator {
  return page.getByTestId('stats').getByText(label, { exact: true }).locator('..');
}

async function goTo(page: Page, view: string) {
  await page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name: view }).click();
}

/** Uma linha da lista de respostas da seção "Candidatura" do painel da vaga. */
function answerRow(section: Locator, label: string): Locator {
  return section.getByTestId('application-answers').locator('dl > div').filter({ hasText: label });
}

test('automatic application: rehearsal, the owner answers once, both rehearsals sent for real', async ({ page }) => {
  test.setTimeout(600_000);
  const { problems } = collectProblems(page);
  await page.goto('/');

  // --- Antes: a vaga React volta para Descobertas --------------------------------------------------------------------
  // board.spec.ts a deixou em Selecionadas, e a candidatura automática só pega vagas em Descobertas (o dono que move um
  // card já cuidou dele).
  await goTo(page, 'Quadro');
  await card(page, REACT_JOB).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: 'Mover para Descobertas' }).click();
  await expect(drawer.getByRole('button', { name: 'Descobertas (coluna atual)' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('column-descobertas').getByTestId('job-card').filter({ hasText: REACT_JOB })).toBeVisible();

  // --- 1. Configurações: liga a função e põe a nota mínima em 0 -------------------------------------------------------
  await goTo(page, 'Configurações');
  const section = page.getByTestId('settings-apply');
  await expect(page.getByTestId('apply-unavailable')).toHaveCount(0);
  const enabled = page.getByTestId('apply-enabled');
  await expect(enabled).toHaveAttribute('aria-checked', 'false'); // nasce desligada
  await enabled.click();
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('apply-min-score').fill('0');
  // O site de teste continua em Ensaio, o padrão.
  await expect(page.getByTestId('apply-mode-fake').getByRole('radio', { name: 'Ensaio' })).toHaveAttribute('aria-checked', 'true');
  // As respostas propostas pela IA ficam no padrão.
  const review = page.getByTestId('apply-ai-answers-review');
  await expect(review).toContainText('Com a sua aprovação');
  await expect(review.getByRole('radio')).toBeChecked();
  // O horário cobre o dia inteiro (a tela só aceita início antes do fim): o teste passa a qualquer hora.
  await page.getByTestId('apply-window-start').fill('00:00');
  await page.getByTestId('apply-window-end').fill('23:59');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('toast-region').getByRole('status')).toContainText('Configurações salvas');
  await expect(page.getByTestId('settings-save')).toBeDisabled();
  await expect(section.getByTestId('apply-today')).toContainText('Salva como ligada.');
  await snapshot(page, 'apply-settings.png');

  // --- 2. Perfis de busca: "Buscar agora"; as duas vagas chegam ao quadro ---------------------------------------------
  // O perfil de board.spec.ts filtra por React; este pega as duas vagas da fonte falsa (mesma empresa).
  await goTo(page, 'Perfis de busca');
  await page.getByPlaceholder('React Pleno remoto').fill('E2E candidatura');
  await page.getByPlaceholder('react, node, typescript').fill('react, node');
  await page.getByLabel('Fake', { exact: true }).check();
  await page.getByRole('button', { name: 'Salvar perfil' }).click();
  const profile = page.getByTestId('profile').filter({ hasText: 'E2E candidatura' });
  await expect(profile).toHaveCount(1);
  await profile.getByRole('button', { name: 'Buscar agora' }).click();
  await expect(page.getByTestId('toast-region').getByRole('status')).toContainText('Busca enfileirada em 1 fonte');
  // O worker verifica a fila a cada 5 s; o quadro só refaz a consulta a cada 15 s.
  await expect
    .poll(async () => ((await (await page.request.get('/api/jobs')).json()) as { title: string }[]).map((j) => j.title).sort(), {
      timeout: 60_000,
    })
    .toEqual([NODE_JOB, REACT_JOB]);
  await goTo(page, 'Quadro');
  await expect(card(page, REACT_JOB)).toBeVisible({ timeout: 30_000 });
  await expect(card(page, NODE_JOB)).toBeVisible({ timeout: 30_000 });

  // --- 3. O contador "Precisam de você" passa de zero: a pretensão salarial não tem resposta ---------------------------
  // Espera as DUAS candidaturas pararem nas mesmas perguntas (a vaga Node chega e ganha nota alguns segundos depois da
  // React): assim o passo 5 confere que a segunda volta à fila sozinha quando o dono responde a primeira.
  const needsHuman = page.getByTestId('stats-needs-human');
  await expect(needsHuman).toHaveAttribute('aria-label', /^Precisam de você: 2\./, { timeout: WORKER_WAIT });
  await snapshot(page, 'apply-needs-you.png');

  // --- 4. Candidaturas: responde o salário e os anos, "sempre", e continua --------------------------------------------
  await needsHuman.click();
  await expect(page.getByTestId('applications-filter-needs_human')).toHaveAttribute('aria-pressed', 'true');
  const rows = page.locator('[data-testid^="application-row-"]');
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  const row = rows.first();
  const rowTestId = (await row.getAttribute('data-testid'))!;
  const otherTestId = (await rows.nth(1).getAttribute('data-testid'))!;
  await row.getByRole('button').first().click();
  const pending = page.getByTestId('pending-questions');
  await expect(pending).toBeVisible();
  // Só as duas obrigatórias sem resposta; o resto o app respondeu (regra) ou deixou em branco (opcional).
  await expect(pending.locator('[data-testid^="pending-"][role="group"]')).toHaveCount(2);
  for (const id of ['salary', 'years_ts']) {
    const item = page.getByTestId(`pending-${id}`);
    await expect(item).toContainText('sem resposta');
    await expect(page.getByTestId(`pending-answer-${id}`)).toHaveValue('');
  }
  await page.getByTestId('pending-answer-salary').fill(SALARY);
  await page.getByTestId('pending-scope-salary').getByRole('radio', { name: 'sempre' }).click();
  await page.getByTestId('pending-answer-years_ts').fill(YEARS);
  await page.getByTestId('pending-scope-years_ts').getByRole('radio', { name: 'sempre' }).click();
  await snapshot(page, 'apply-pending.png');
  await page.getByTestId('pending-submit').click();
  // A candidatura sai de "Precisam de você" (a lista mostra só esse filtro), e a outra, que esperava as mesmas
  // perguntas, sai junto: o teste não respondeu nada por ela.
  await expect(page.getByTestId(rowTestId)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId(otherTestId)).toHaveCount(0, { timeout: 30_000 });

  // --- 5. As duas viram "ensaio pronto"; nenhuma em Aplicada --------------------------------------------------------
  // A outra candidatura voltou sozinha à fila e usou as respostas salvas.
  await goTo(page, 'Quadro');
  for (const title of [REACT_JOB, NODE_JOB]) {
    await expect(card(page, title).getByTestId('job-badge-rehearsal')).toBeVisible({ timeout: WORKER_WAIT });
  }
  await expect(page.getByTestId('column-aplicada').getByTestId('job-card')).toHaveCount(0);
  await expect(counter(page, 'Aplicadas pela IA')).toHaveText('Aplicadas pela IA0');
  await expect(needsHuman).toHaveAttribute('aria-label', /^Precisam de você: 0\./, { timeout: 30_000 });
  await snapshot(page, 'apply-rehearsals.png');

  // --- 6. Abre a vaga React: o ensaio mostra as respostas salvas; "Enviar de verdade" ---------------------------------
  await card(page, REACT_JOB).click();
  const application = drawer.getByTestId('job-application');
  await expect(application).toContainText('Ensaio pronto');
  const salary = answerRow(application, 'Pretensão salarial mensal (R$)');
  await expect(salary).toContainText(SALARY);
  await expect(salary).toContainText('sua resposta');
  const years = answerRow(application, 'Anos de experiência com TypeScript');
  await expect(years).toContainText(YEARS);
  await expect(years).toContainText('sua resposta');
  await expect(answerRow(application, 'Por que você quer trabalhar aqui?')).toContainText('em branco');
  await snapshot(page, 'apply-drawer-rehearsal.png');
  await application.getByTestId('application-send').click();

  // --- 7. A vaga vai para Aplicada com "aplicada pela IA"; o site confirmou; o PDF responde ---------------------------
  const applied = page.getByTestId('column-aplicada').getByTestId('job-card').filter({ hasText: REACT_JOB });
  await expect(applied.getByTestId('job-badge-applied_by_ai')).toBeVisible({ timeout: WORKER_WAIT });
  await expect(application).toContainText('Candidatura recebida', { timeout: 30_000 });
  await expect(application).toContainText('Enviada');
  const href = await application.getByTestId('application-resume').getAttribute('href');
  expect(href).toBeTruthy();
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  // Depois do envio não há como mandar de novo: nem "Tentar de novo", nem "Enviar de verdade".
  await expect(application.getByTestId('application-retry')).toHaveCount(0);
  await expect(application.getByTestId('application-send')).toHaveCount(0);
  await expect(needsHuman).toHaveAttribute('aria-label', /^Precisam de você: 0\./);
  await snapshot(page, 'apply-drawer-sent.png');
  await drawer.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // --- 8. Candidaturas: "Enviar todos os ensaios"; a vaga Node também vai para Aplicada --------------------------------
  await goTo(page, 'Candidaturas');
  const sendAll = page.getByTestId('applications-send-all');
  await expect(sendAll).toContainText('Enviar todos os ensaios (1)');
  await sendAll.click();
  await page.getByTestId('applications-send-all-dialog-confirm').click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await goTo(page, 'Quadro');
  await expect(
    page.getByTestId('column-aplicada').getByTestId('job-card').filter({ hasText: NODE_JOB }).getByTestId('job-badge-applied_by_ai'),
  ).toBeVisible({ timeout: WORKER_WAIT });
  await expect(counter(page, 'Aplicadas pela IA')).toHaveText('Aplicadas pela IA2', { timeout: 30_000 });
  await expect(needsHuman).toHaveAttribute('aria-label', /^Precisam de você: 0\./);
  await snapshot(page, 'apply-board-applied.png');
  // A vaga Node foi enviada com as respostas que o dono deu uma vez, para a outra candidatura.
  await card(page, NODE_JOB).click();
  await expect(application).toContainText('Candidatura recebida');
  await expect(answerRow(application, 'Pretensão salarial mensal (R$)')).toContainText(`${SALARY}Origem: sua resposta`);
  await expect(answerRow(application, 'Anos de experiência com TypeScript')).toContainText(`${YEARS}Origem: sua resposta`);
  await expect(application.getByTestId('application-retry')).toHaveCount(0);
  await expect(application.getByTestId('application-send')).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Fechar' }).click();

  expect(problems, 'erros de console, exceções ou requisições com falha').toEqual([]);
});
