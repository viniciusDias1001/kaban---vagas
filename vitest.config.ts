import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.browser.test.ts'],
    // Cada arquivo de teste com banco sobe um PGlite no beforeAll; sob CPU disputada isso passa dos 10 s padrão.
    hookTimeout: 60_000,
  },
});
