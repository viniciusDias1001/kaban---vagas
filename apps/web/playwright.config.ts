import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import { E2E_DATABASE_URL, e2eDatabaseName } from './e2e/database';

// Falha já ao carregar a config se a URL apontar para um banco que não é de teste.
e2eDatabaseName(E2E_DATABASE_URL);

const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  // Um único banco e um único trio web/api/worker: os testes não podem rodar em paralelo.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // O preparo do banco vem antes do `pnpm dev` (que roda `db:migrate` e sobe api, worker e web).
    command: 'pnpm exec tsx apps/web/e2e/prepare-db.ts && pnpm dev',
    cwd: '../..',
    // Passa pelo proxy do Vite até a API: só responde 200 quando os dois estão no ar.
    url: 'http://localhost:5173/api/sources',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: CI ? 'pipe' : 'ignore',
    stderr: 'pipe',
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
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
    },
  },
});
