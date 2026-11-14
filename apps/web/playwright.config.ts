import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import { E2E_APPLY_DATA_DIR } from './e2e/apply-data';
import { E2E_DATABASE_URL, e2eDatabaseName } from './e2e/database';
import { E2E_API_PORT, E2E_WEB_PORT, E2E_WEB_URL } from './e2e/ports';

// Falha já ao carregar a config se a URL apontar para um banco que não é de teste.
e2eDatabaseName(E2E_DATABASE_URL);

const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  // Roda depois de o webServer subir: aborta a suíte se o servidor alcançado não for o do e2e (GET /api/meta).
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  // Um único banco e um único trio web/api/worker: os testes não podem rodar em paralelo.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: E2E_WEB_URL,
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // O preparo do banco vem antes do `pnpm dev` (que roda `db:migrate` e sobe api, worker e web).
    command: 'pnpm exec tsx apps/web/e2e/prepare-db.ts && pnpm dev',
    cwd: '../..',
    // Passa pelo proxy do Vite até a API: só responde 200 quando os dois estão no ar. Qualquer API responderia aqui;
    // quem confere que é a do e2e é o globalSetup.
    url: `${E2E_WEB_URL}/api/meta`,
    // Nunca reaproveita um servidor que já está no ar: com a porta do web ocupada (o `pnpm dev` do dono na 5173, por
    // exemplo), o Playwright recusa começar. O vite.config.ts fixa a porta de WEB_PORT (strictPort): o Vite nunca troca
    // de porta sozinho. Para rodar ao lado do `pnpm dev`, E2E_WEB_PORT e E2E_API_PORT (e2e/ports.ts) trocam as duas.
    reuseExistingServer: false,
    timeout: 120_000,
    // E2E_SERVER_LOGS=1 mostra a saída da api, do worker e do web também fora da CI (para investigar uma falha).
    stdout: CI || process.env.E2E_SERVER_LOGS ? 'pipe' : 'ignore',
    stderr: 'pipe',
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      // Uma porta só da API do e2e, nunca a 3333 do app do dono: se ela estivesse ocupada pela API dele, o proxy do Vite
      // levaria os testes até ela. Vence o API_PORT do .env de quem roda; PORT vazia para não ter precedência sobre ela.
      // O proxy do Vite lê a mesma variável.
      API_PORT: E2E_API_PORT,
      PORT: '',
      WEB_PORT: E2E_WEB_PORT,
      FAKE_CONNECTORS: '1',
      // IA: nenhum provedor no ambiente (o teste escolhe pela aba Configurações). AI_ALLOW_FAKE só libera o
      // provedor falso entre as opções; ele não usa rede nem chave.
      AI_PROVIDER: '',
      AI_ALLOW_FAKE: '1',
      // Segredo só deste servidor de teste, para a gravação de chave pela tela funcionar. É sorteado a cada
      // execução e nunca sai daqui: o banco do e2e é esvaziado no preparo, então nada cifrado com um
      // segredo anterior sobra. A CI não precisa de nenhum segredo configurado.
      APP_SECRET: randomBytes(32).toString('base64url'),
      // Vazias de propósito: valores do ambiente do processo vencem os do .env de quem roda, e uma chave de
      // verdade ali faria a tela mostrar "definida pelo ambiente". O e2e nunca usa chave real.
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      AI_MODEL_FAST: '',
      AI_MODEL_STRONG: '',
      AI_DAILY_BUDGET_USD: '',
      // Candidatura automática: só o site de teste (servido localmente, sem rede) num Chromium do Playwright sem
      // janela, que o worker usa no lugar do navegador do dono. APPLY_BROWSER vazia para o .env de quem roda não
      // trocar o navegador; HOST vazia para a função ficar disponível (só existe com HOST local).
      FAKE_APPLY_SITE: '1',
      APPLY_BROWSER: '',
      HOST: '',
      // Nunca vazia: sem ela, a API e o worker usariam a pasta de dados de verdade do dono (o perfil do navegador
      // dele). O preparo do banco esvazia esta pasta a cada execução.
      APPLY_DATA_DIR: E2E_APPLY_DATA_DIR,
      // E-mail: a caixa falsa (um arquivo em `<APPLY_DATA_DIR>/fake-mail`, que o teste enche com `deliverFakeMail`) e o
      // aviso no celular falso, no lugar do Gmail e do Telegram; a leitura roda a cada 3 s. Nada sai da máquina.
      FAKE_MAIL: '1',
    },
  },
});
