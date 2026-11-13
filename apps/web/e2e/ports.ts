/**
 * Portas do e2e. A API tem uma porta só dela (nunca a 3333 do app do dono): a variável vence um `API_PORT` do `.env` de
 * quem roda, e o proxy do Vite lê a mesma variável. O web fica na 5173 (o `vite.config.ts` a fixa com `strictPort`): com
 * `reuseExistingServer: false`, o Playwright recusa começar se ela já estiver em uso.
 */
export const E2E_API_PORT = '3399';
export const E2E_WEB_URL = 'http://localhost:5173';
