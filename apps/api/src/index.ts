import { assertDbReady, closeDb, createDb } from '@kv/db';
import { buildApp } from './app';
import { resolveListen, resolveWebDist } from './config';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

try {
  const { host, port } = resolveListen();
  const webDist = resolveWebDist();
  // A API não roda migrations (isso é do `pnpm db:migrate`); só confere que o banco está pronto.
  const db = createDb();
  await assertDbReady(db);
  const app = buildApp(db, { webDist });
  await app.listen({ port, host });
  console.log(`[api] http://${host}:${port}${webDist ? ` (servindo o web de ${webDist})` : ''}`);

  // Redeploy/Ctrl+C: para de aceitar conexões, termina as requisições em andamento e fecha o pool.
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[api] ${signal} recebido, encerrando`);
    // Se algo travar (conexão presa, banco fora do ar), sai mesmo assim antes do SIGKILL da plataforma.
    setTimeout(() => process.exit(1), 8_000).unref();
    try {
      await app.close();
      await closeDb(db);
      console.log('[api] encerrada');
      process.exit(0);
    } catch (e) {
      console.error(`[api] erro ao encerrar: ${errorText(e)}`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
} catch (err) {
  console.error(`[api] ${errorText(err)}`);
  process.exit(1);
}
