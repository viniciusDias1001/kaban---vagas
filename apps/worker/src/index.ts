import { getConnectors } from '@kv/connectors';
import { assertDbReady, createDb, type Db } from '@kv/db';
import { enqueueAllActive, failStaleRuns, isDue, processQueue, scheduleHourly } from './scheduler';

const POLL_MS = 5_000;
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
setInterval(async () => {
  if (busy) return;
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

log('worker iniciado; busca a cada hora cheia, fila verificada a cada 5 s');
