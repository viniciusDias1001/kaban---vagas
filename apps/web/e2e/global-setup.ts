/**
 * Antes de qualquer teste: confere que o servidor alcançado pelo e2e é o DELE. O Playwright sobe o webServer antes deste
 * arquivo; se a API do e2e não subiu (porta ocupada) e outra API respondeu no lugar (a de verdade do dono, por exemplo),
 * os testes gravariam nas configurações dele e o worker dele abriria sites de verdade. A API diz em que banco está
 * (`GET /meta`); só um banco terminado em `_e2e` ou `_test`, e o mesmo que o e2e preparou, deixa a suíte começar.
 */
import { E2E_API_PORT, E2E_WEB_URL } from './ports';
import { E2E_DATABASE_URL, e2eDatabaseName } from './database';

export default async function globalSetup(): Promise<void> {
  const expected = e2eDatabaseName(E2E_DATABASE_URL);
  const url = `${E2E_WEB_URL}/api/meta`;
  let database: unknown;
  try {
    const res = await fetch(url);
    database = res.ok ? ((await res.json()) as { database?: unknown }).database : `HTTP ${res.status}`;
  } catch (e) {
    database = e instanceof Error ? e.message : String(e);
  }
  if (typeof database !== 'string' || !/_(e2e|test)$/.test(database) || database !== expected) {
    throw new Error(
      `[e2e] o servidor em ${url} não é o do e2e (banco: ${String(database)}; esperado: ${expected}). ` +
        `A API do e2e roda na porta ${E2E_API_PORT}: confira se ela está livre e se nenhum outro app usa a porta 5173. ` +
        'Nenhum teste rodou.',
    );
  }
}
