/**
 * Portas do e2e. A API tem uma porta só dela (nunca a 3333 do app do dono): a variável vence um `API_PORT` do `.env` de
 * quem roda, e o proxy do Vite lê a mesma variável. O web fica na porta de `WEB_PORT` (o `vite.config.ts` a fixa com
 * `strictPort`): com `reuseExistingServer: false`, o Playwright recusa começar se ela já estiver em uso.
 *
 * `E2E_API_PORT` (padrão 3399) e `E2E_WEB_PORT` (padrão 5173) trocam as duas, para o e2e rodar ao lado de um `pnpm dev`
 * que já ocupa a 5173 e a 3333 (ex.: `E2E_WEB_PORT=5174 E2E_API_PORT=3334 pnpm e2e`).
 */
function port(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^\d{2,5}$/.test(value) || Number(value) > 65_535) throw new Error(`${name}="${value}" não é uma porta válida.`);
  return value;
}

export const E2E_API_PORT = port('E2E_API_PORT', '3399');
export const E2E_WEB_PORT = port('E2E_WEB_PORT', '5173');
export const E2E_WEB_URL = `http://localhost:${E2E_WEB_PORT}`;
