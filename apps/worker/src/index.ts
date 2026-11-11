import { getConnectors } from '@kv/connectors';
import { assertDbReady, closeDb, createDb, type Db } from '@kv/db';
import { enqueueAllActive, failStaleRuns, isDue, processQueue, scheduleHourly } from './scheduler';

const POLL_MS = 5_000;
/** Quanto o encerramento espera os runs em andamento (o container tem ~10 s entre o SIGTERM e o SIGKILL). */
const DRAIN_MS = 4_000;
const log = (msg: string) => console.log(`[worker ${new Date().toISOString()}] ${msg}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** O worker não roda migrations (isso é do `pnpm db:migrate`); só confere que o banco está pronto. */
async function connect(): Promise<Db> {
  try {
    const db = createDb();
    await assertDbReady(db);
    return db;
  } catch (e) {
    console.error(`[worker] ${errorText(e)}`);
    process.exit(1);
  }
}

const db = await connect();

await failStaleRuns(db);

if (await isDue(db)) log(`busca inicial: ${await enqueueAllActive(db)} runs enfileirados`);

scheduleHourly(() => {
  enqueueAllActive(db).then(
    (n) => log(`busca horária: ${n} runs enfileirados`),
    (e) => log(`erro na busca horária: ${errorText(e)}`),
  );
});

let busy = false;
let stopping = false;
const poll = setInterval(async () => {
  if (busy || stopping) return;
  busy = true;
  try {
    const done = await processQueue(db, getConnectors());
    if (done > 0) log(`${done} runs executados`);
  } catch (e) {
    log(`erro na fila: ${errorText(e)}`);
  } finally {
    busy = false;
  }
}, POLL_MS);

/**
 * Redeploy/Ctrl+C: para de pegar runs da fila, espera um pouco os que estão em andamento e fecha o pool.
 * O que não terminar a tempo fica como "running" e vira erro no próximo start (failStaleRuns).
 */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(poll);
  log(`${signal} recebido, encerrando`);
  setTimeout(() => process.exit(1), DRAIN_MS + 4_000).unref();
  const deadline = Date.now() + DRAIN_MS;
  while (busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (busy) log('runs ainda em andamento; serão marcados como erro no próximo start');
  try {
    await closeDb(db);
  } catch (e) {
    log(`erro ao fechar o banco: ${errorText(e)}`);
  }
  log('worker encerrado');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log('worker iniciado; busca a cada hora cheia, fila verificada a cada 5 s');
