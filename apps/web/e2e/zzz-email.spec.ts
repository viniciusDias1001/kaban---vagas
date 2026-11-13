import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectProblems } from './problems';
import {
  COMPANY, OWNER_ADDRESS, deliver, invite, invoice, rejection, resetFakeMail, salaryRequest, sentMail,
} from './mail-data';

/**
 * A caixa de e-mail de ponta a ponta, contra a caixa falsa (FAKE_MAIL=1 no playwright.config: um arquivo na pasta de dados
 * do e2e, que o worker lê a cada 3 s) e o provedor de IA falso, que classifica pela palavra-chave do e-mail
 * (`email_classify` em packages/ai/src/fake.ts). Nenhum servidor de e-mail é aberto e nada sai da máquina.
 *
 * Roda depois de zz-apply.spec.ts (ordem alfabética) e aproveita o estado que ele deixa: provedor falso escolhido, perfil
 * enviado e as duas vagas da fonte falsa ("Fake Corp") em Aplicada. Os modos do e-mail ficam no padrão: mover
 * automático, responder com dados salvos automático e rascunhos da IA ligados.
 *
 * As duas vagas são da mesma empresa: o modelo falso liga o e-mail à primeira candidata que o código lhe oferece (a de
 * candidatura mais recente). O teste não supõe qual é: lê a vaga ligada pela API e segue com ela.
 */

/** Esperas que dependem do worker: leitura a cada 3 s, depois a classificação e a ação, cada uma numa volta da fila. */
const WORKER_WAIT = 90_000;
/** O quadro refaz a consulta a cada 15 s; o sino também. */
const BOARD_WAIT = 40_000;
const SALARY = '18000';

interface MailRow {
  id: number; direction: 'in' | 'out'; subject: string; kind: string | null; jobId: number | null; movedTo: string | null;
  corrected: boolean; replyState: string | null; replyApprovedBy: 'auto' | 'owner' | null; alerted: boolean;
}
interface AlertRow { id: number; kind: string; jobId: number | null; replyId: number | null }

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `GET ${url}`).toBeTruthy();
  return (await res.json()) as T;
}

const mailRows = (page: Page) => getJson<MailRow[]>(page, '/api/email/messages');

/** Espera o e-mail recebido de assunto `subject` chegar ao estado que `done` pede, e devolve a linha. */
async function waitForMail(page: Page, subject: string, done: (m: MailRow) => boolean): Promise<MailRow> {
  let found: MailRow | undefined;
  await expect
    .poll(async () => {
      found = (await mailRows(page)).find((m) => m.direction === 'in' && m.subject === subject);
      return found ? done(found) : false;
    }, { timeout: WORKER_WAIT, intervals: [1_000] })
    .toBe(true);
  return found!;
}

async function jobTitle(page: Page, jobId: number): Promise<string> {
  const jobs = await getJson<{ id: number; title: string }[]>(page, '/api/jobs');
  const job = jobs.find((j) => j.id === jobId);
  expect(job, `vaga ${jobId}`).toBeTruthy();
  return job!.title;
}

async function goTo(page: Page, view: string) {
  await page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name: view }).click();
}

const cardIn = (page: Page, column: string, title: string): Locator =>
  page.getByTestId(`column-${column}`).getByTestId('job-card').filter({ hasText: title });

async function closeDrawer(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.describe.serial('e-mail', () => {
  test.beforeAll(() => {
    // O preparo do banco já esvazia a pasta de dados do e2e; a caixa falsa é limpa de novo para não depender disso.
    resetFakeMail();
  });

  test('mailbox: rejection with undo, saved fact answered, invite approved, invoice ignored', async ({ page }) => {
    test.setTimeout(600_000);
    const { problems } = collectProblems(page);
    await page.goto('/');

    // --- 1. Configurações > E-mail: conecta a caixa ------------------------------------------------------------------
    await goTo(page, 'Configurações');
    const settings = page.getByTestId('settings-email');
    await expect(settings.getByTestId('email-state')).toHaveText('Não conectada');
    await settings.getByTestId('email-address').fill(OWNER_ADDRESS);
    // Qualquer senha serve para a caixa falsa (menos "senha-errada").
    await settings.getByTestId('email-password').fill('abcd efgh ijkl mnop');
    await settings.getByTestId('email-connect').click();
    await expect(settings.getByTestId('email-state')).toHaveText('Conectada', { timeout: 30_000 });
    // A senha nunca volta à tela.
    await expect(settings.getByTestId('email-password')).toHaveCount(0);
    // A primeira leitura (vazia) termina antes de qualquer entrega: o que chega depois não é "primeira leitura".
    await expect
      .poll(async () => (await getJson<{ lastReadAt: number | null }>(page, '/api/email/account')).lastReadAt, { timeout: WORKER_WAIT })
      .not.toBeNull();

    // --- 2. Reprovação: o card vai para Perdida; o histórico mostra o e-mail; Desfazer o devolve a Aplicada ---------
    const rejected = deliver(rejection());
    const rejectionRow = await waitForMail(page, rejected.subject, (m) => m.movedTo === 'perdida');
    expect(rejectionRow.kind).toBe('reprovacao');
    expect(rejectionRow.jobId).not.toBeNull();
    const jobId = rejectionRow.jobId!;
    const title = await jobTitle(page, jobId);

    await goTo(page, 'Quadro');
    await expect(cardIn(page, 'perdida', title)).toBeVisible({ timeout: BOARD_WAIT });
    await cardIn(page, 'perdida', title).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.locator('[data-testid^="history-mail-"]').filter({ hasText: 'E-mail — Reprovação' })).toHaveCount(1);
    await expect(drawer.getByTestId(`job-email-${rejectionRow.id}`)).toContainText('Moveu o card para Perdida');
    await drawer.getByTestId(`job-email-undo-${rejectionRow.id}`).click();
    await expect(drawer.getByRole('button', { name: 'Aplicada (coluna atual)' })).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByTestId(`job-email-${rejectionRow.id}`)).toContainText('(desfeito)');
    await closeDrawer(page);
    await expect(cardIn(page, 'aplicada', title)).toBeVisible({ timeout: BOARD_WAIT });
    await expect(cardIn(page, 'perdida', title)).toHaveCount(0);

    // --- 3. Pedido de um fato salvo: a pretensão salarial sai sozinha, com texto fixo ---------------------------------
    await goTo(page, 'Meu perfil');
    const salaryField = page.getByTestId('apply-answer-salary_brl_month');
    await salaryField.fill(SALARY);
    await salaryField.blur();
    await expect(page.getByTestId('apply-answer-row-salary_brl_month')).toContainText('Salvo', { timeout: 15_000 });

    const asked = deliver(salaryRequest());
    const askedRow = await waitForMail(page, asked.subject, (m) => m.replyState === 'enviada');
    expect(askedRow.kind).toBe('pedido');
    expect(askedRow.replyApprovedBy).toBe('auto');
    const sentAfterRequest = sentMail();
    expect(sentAfterRequest).toHaveLength(1);
    expect(sentAfterRequest[0]!.to).toEqual(['joana@fake.example']);
    expect(sentAfterRequest[0]!.inReplyTo).toBe(asked.messageId);
    expect(sentAfterRequest[0]!.text).toContain('R$');
    expect(sentAfterRequest[0]!.text).toContain('18.000');

    const askedTitle = await jobTitle(page, askedRow.jobId!);
    await goTo(page, 'Quadro');
    await page.getByTestId('job-card').filter({ hasText: askedTitle }).first().click();
    const emails = drawer.getByTestId('job-emails');
    await expect(emails).toContainText(asked.subject);
    await expect(emails).toContainText('enviada automaticamente');
    await closeDrawer(page);

    // --- 4. Convite: o card vai para Entrevista; o sino tem o rascunho; nada sai sem a lacuna preenchida e o OK -------
    const invited = deliver(invite());
    const inviteRow = await waitForMail(page, invited.subject, (m) => m.movedTo === 'entrevista' && m.replyState === 'rascunho');
    const inviteTitle = await jobTitle(page, inviteRow.jobId!);
    await expect(cardIn(page, 'entrevista', inviteTitle)).toBeVisible({ timeout: BOARD_WAIT });
    await expect(page.getByTestId('alert-count')).toHaveText('1', { timeout: BOARD_WAIT });
    const alerts = (await getJson<{ alerts: AlertRow[] }>(page, '/api/alerts')).alerts;
    expect(alerts.map((a) => a.kind)).toEqual(['interview']);
    const alertId = alerts[0]!.id;

    await page.getByTestId('alert-bell').click();
    const draft = page.getByTestId(`alert-draft-${alertId}`);
    const approve = page.getByTestId(`alert-approve-${alertId}`);
    await expect(draft).toHaveValue(/\[\[seus horários\]\]/);
    await expect(approve).toBeDisabled();
    // Preencher a lacuna não basta: o que sai é o texto salvo.
    const filled = (await draft.inputValue()).replace('[[seus horários]]', 'terça ou quarta, das 10h às 12h');
    await draft.fill(filled);
    await expect(approve).toBeDisabled();
    await page.getByTestId(`alert-save-${alertId}`).click();
    await expect(approve).toBeEnabled({ timeout: 15_000 });
    expect(sentMail()).toHaveLength(1);
    await approve.click();
    await expect.poll(() => sentMail().length, { timeout: WORKER_WAIT }).toBe(2);
    const inviteReply = sentMail()[1]!;
    expect(inviteReply.inReplyTo).toBe(invited.messageId);
    expect(inviteReply.text).toContain('terça ou quarta, das 10h às 12h');
    expect(inviteReply.text).not.toContain('[[');
    await page.getByTestId('alert-panel').getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByTestId('alert-panel')).toHaveCount(0);

    // --- 5. Fora do filtro: a fatura da mesma empresa não entra na vaga e aparece em E-mails ignorados ---------------
    const before = await getJson<{ messages: unknown[] }>(page, `/api/jobs/${inviteRow.jobId}/emails`);
    const bill = deliver(invoice());
    await expect
      .poll(async () => (await getJson<{ subject: string; company: string }[]>(page, '/api/email/ignored')).filter((i) => i.subject === bill.subject), {
        timeout: WORKER_WAIT, intervals: [1_000],
      })
      .toEqual([expect.objectContaining({ subject: bill.subject, company: COMPANY })]);
    // A leitura que ignorou a fatura já passou: nada dela foi guardado.
    expect((await mailRows(page)).filter((m) => m.subject === bill.subject)).toEqual([]);
    expect((await getJson<{ messages: unknown[] }>(page, `/api/jobs/${inviteRow.jobId}/emails`)).messages).toHaveLength(before.messages.length);
    await goTo(page, 'Configurações');
    await expect(settings.locator('[data-testid^="email-ignored-"]').filter({ hasText: bill.subject })).toHaveCount(1);
    await goTo(page, 'Quadro');
    await cardIn(page, 'entrevista', inviteTitle).click();
    await expect(drawer.getByTestId('job-emails')).not.toContainText(bill.subject);
    await closeDrawer(page);

    expect(sentMail(), 'nada além das duas respostas saiu').toHaveLength(2);
    expect(problems, 'erros de console, exceções ou requisições com falha').toEqual([]);
  });

  test('Painel: numbers, funnel, e-mail block and the mail list after the mailbox scenarios', async ({ page }) => {
    test.setTimeout(300_000);
    const { problems } = collectProblems(page);
    await page.goto('/');

    // A reprovação do teste anterior foi desfeita: com `corrected`, ela não conta em número nenhum do Painel. Uma
    // segunda reprovação, sem Desfazer, é a que o bloco de e-mails e a lista mostram.
    const lost = deliver(rejection(`Atualização sobre o processo seletivo - ${COMPANY}`));
    const lostRow = await waitForMail(page, lost.subject, (m) => m.movedTo === 'perdida');
    expect(lostRow.kind).toBe('reprovacao');
    expect(lostRow.corrected).toBe(false);
    const askedRow = (await mailRows(page)).find((m) => m.direction === 'in' && m.subject === salaryRequest().subject);
    expect(askedRow?.replyState).toBe('enviada');

    // Os números vêm do servidor; a tela mostra os mesmos.
    const dto = await getJson<{ applied: { total: number }; email: { received: Record<string, number> } }>(page, '/api/dashboard?period=30');
    expect(dto.applied.total).toBeGreaterThanOrEqual(1);
    expect(dto.email.received.reprovacao).toBeGreaterThanOrEqual(1);

    await goTo(page, 'Painel');
    const blocks = page.getByTestId('painel-blocks');
    await expect(blocks).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('painel-period').getByRole('radio', { name: '30 dias' })).toHaveAttribute('aria-checked', 'true');
    const applied = page.getByTestId('kpi-applied');
    await expect(applied.locator('p').nth(1)).toHaveText(String(dto.applied.total));
    expect(Number(await applied.locator('p').nth(1).innerText())).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('painel-funnel')).toBeVisible();
    await expect(page.getByTestId('painel-email')).toContainText('Reprovação');
    // Poucos dados: número e base, nunca uma conta quebrada.
    await expect(blocks).not.toContainText('NaN');
    await expect(blocks).not.toContainText('Infinity');

    // --- A lista: a reprovação moveu o card; o pedido foi respondido sozinho -----------------------------------------
    const list = page.getByTestId('painel-mail-list');
    await expect(list.getByTestId(`painel-mail-row-${lostRow.id}`)).toContainText('moveu o card para Perdida');
    await expect(list.getByTestId(`painel-mail-row-${lostRow.id}`)).toContainText('Reprovação');
    await expect(list.getByTestId(`painel-mail-row-${askedRow!.id}`)).toContainText('respondeu sozinho');
    const rows = list.locator('[data-testid^="painel-mail-row-"]');
    const allRows = await rows.count();
    expect(allRows).toBeGreaterThanOrEqual(2);

    // "Sem vaga": todos os e-mails desta execução estão ligados a uma vaga, então a lista esvazia.
    const unmatched = await getJson<unknown[]>(page, '/api/email/messages?unmatched=1');
    await list.getByTestId('painel-mail-filter-unmatched').click();
    if (unmatched.length === 0) {
      await expect(list.getByTestId('painel-mail-empty')).toBeVisible();
      await expect(rows).toHaveCount(0);
    } else {
      await expect(rows).toHaveCount(unmatched.length);
      expect(unmatched.length).toBeLessThan(allRows);
    }
    await list.getByTestId('painel-mail-filter-unmatched').click();
    await expect(rows).toHaveCount(allRows);

    // --- Período de 7 dias: a página continua de pé ------------------------------------------------------------------
    await page.getByTestId('painel-period').getByRole('radio', { name: '7 dias' }).click();
    await expect(page.getByTestId('painel-period').getByRole('radio', { name: '7 dias' })).toHaveAttribute('aria-checked', 'true');
    await expect(blocks).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
    await expect(page.getByText('Não foi possível carregar o Painel')).toHaveCount(0);
    await expect(applied.locator('p').nth(1)).toHaveText(String(dto.applied.total));
    await expect(page.getByTestId('painel-email')).toContainText('Reprovação');
    await expect(list.getByTestId(`painel-mail-row-${lostRow.id}`)).toBeVisible();
    await expect(blocks).not.toContainText('NaN');

    expect(problems, 'erros de console, exceções ou requisições com falha').toEqual([]);
  });
});
