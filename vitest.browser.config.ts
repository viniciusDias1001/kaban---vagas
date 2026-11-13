import { defineConfig } from 'vitest/config';

// Testes que abrem o Chromium do Playwright (sem janela, rede cortada). Rodam com `pnpm test:browser`.
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.browser.test.ts', 'apps/**/src/**/*.browser.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
