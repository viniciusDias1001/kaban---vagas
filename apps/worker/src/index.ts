import { getConnectors } from '@kv/connectors';
import { openDb } from '@kv/db';
import { enqueueAllActive, failStaleRuns, isDue, processQueue, scheduleHourly } from './scheduler';

const POLL_MS = 5_000;
const db = openDb();
const log = (msg: string) => console.log(`[worker ${new Date().toISOString()}] ${msg}`);

failStaleRuns(db);

if (isDue(db)) log(`busca inicial: ${enqueueAllActive(db)} runs enfileirados`);

scheduleHourly(() => log(`busca horária: ${enqueueAllActive(db)} runs enfileirados`));

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const done = await processQueue(db, getConnectors());
    if (done > 0) log(`${done} runs executados`);
  } catch (e) {
    log(`erro na fila: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy = false;
  }
}, POLL_MS);

log('worker iniciado; busca a cada hora cheia, fila verificada a cada 5 s');
