import { getConnectors } from '@kv/connectors';
import { closeDb, createDb, waitForDb, type Db } from '@kv/db';
import { createQueue, failStaleRuns, isDue, scheduleHourly } from './scheduler';

const POLL_MS = 5_000;
/** Quanto o encerramento espera os runs em andamento (o container tem ~10 s entre o SIGTERM e o SIGKILL). */
const DRAIN_MS = 4_000;
const log = (msg: string) => console.log(`[worker ${new Date().toISOString()}] ${msg}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * O worker não roda migrations (isso é do `pnpm db:migrate`); só confere que o banco está pronto. Se o
 * banco ainda não responde (tarefa de logon antes do Docker subir, redeploy), insiste por até ~5 min;
 * banco sem tabelas falha na hora.
 */
async function connect(): Promise<Db> {
  try {
    const db = createDb();
    await waitForDb(db, {
      onRetry: ({ attempt, waitMs, error }) =>
        log(`tentativa ${attempt}: ${errorText(error)} Nova tentativa em ${waitMs / 1000} s.`),
    });
    return db;
  } catch (e) {
    console.error(`[worker] ${errorText(e)}`);
    process.exit(1);
  }
}

const db = await connect();

await failStaleRuns(db);

const queue = createQueue(db, getConnectors, { log });

// A busca (a inicial e a de cada hora cheia) é só um pedido: quem enfileira é a verificação da fila, que
// insiste a cada 5 s enquanto o banco estiver fora do ar em vez de pular a hora.
if (await isDue(db)) queue.requestEnqueue();
scheduleHourly(() => queue.requestEnqueue());

let stopping = false;
async function poll() {
  if (stopping) return;
  try {
    const { started, reaped, enqueued } = await queue.tick();
    if (enqueued !== null) log(`busca: ${enqueued} runs enfileirados`);
    if (reaped > 0) log(`${reaped} runs interrompidos marcados como erro`);
    if (started > 0) log(`${started} runs iniciados`);
  } catch (e) {
    log(`erro na fila: ${errorText(e)}`);
  }
}
const timer = setInterval(() => void poll(), POLL_MS);
void poll();

/**
 * Redeploy/Ctrl+C: para de pegar runs da fila, espera um pouco os que estão em andamento e fecha o pool.
 * O que não terminar a tempo fica como "running" e vira erro no próximo start (failStaleRuns).
 */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  log(`${signal} recebido, encerrando`);
  setTimeout(() => process.exit(1), DRAIN_MS + 4_000).unref();
  const drained = await Promise.race([
    queue.idle().then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), DRAIN_MS)),
  ]);
  if (!drained) log('runs ainda em andamento; serão marcados como erro no próximo start');
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

log('worker iniciado; busca a cada hora cheia, fila verificada a cada 5 s (uma busca por fonte de cada vez)');
