import { defineConfig } from 'drizzle-kit';

/** `pnpm db:generate` só compara o schema com o último snapshot; não precisa de banco. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
