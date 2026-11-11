/** Banco usado pelo e2e. Sobrescreva com E2E_DATABASE_URL (o CI aponta para o serviço Postgres do job). */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/kanban_e2e';

/**
 * Nome do banco na URL. Lança se não terminar em `_e2e` ou `_test`: o preparo do e2e apaga todas as
 * linhas, então nunca pode apontar para o banco de desenvolvimento ou de produção.
 */
export function e2eDatabaseName(url: string = E2E_DATABASE_URL): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+(_e2e|_test)$/.test(name)) {
    throw new Error(
      `E2E_DATABASE_URL aponta para o banco "${name}". O e2e apaga todos os dados do banco que usa e por isso ` +
        'só aceita nomes terminados em "_e2e" ou "_test" (ex.: kanban_e2e).',
    );
  }
  return name;
}
