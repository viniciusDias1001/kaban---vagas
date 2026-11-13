import { getConnectors } from '@kv/connectors';
import { closeDb, createDb, waitForDb, type Db } from '@kv/db';
import { createSettingsService } from '@kv/settings';
import { createAiRuntime } from './ai/runtime';
import { createApplyRuntime } from './apply/runtime';
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

// Configurações da aba Configurações (tela > ambiente > padrão), relidas do banco com cache de 5 s.
const settings = createSettingsService(db);

// As listas de empresas do Greenhouse e do Lever são lidas a cada run e entregues ao conector.
const queue = createQueue(db, getConnectors, { log, run: { connectorConfig: () => settings.connectorConfig() } });

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

// Fila de IA: independente da fila de busca, com timer, concorrência, tempo limite e tratamento de erro
// próprios. Uma chamada de IA lenta ou com erro nunca segura o `poll()` acima. A fila existe sempre e
// consulta as configurações a cada verificação: sem provedor ou sem chave ela não faz nada, e começa a
// trabalhar quando a IA é configurada na aba Configurações, sem reiniciar o worker.
const ai = createAiRuntime(db, settings, { log });
{
  // Tarefas que ficaram "running" de um processo anterior: passam pelo mesmo caminho de qualquer falha (a
  // tentativa conta, o uso estimado da chamada perdida é registrado, e quem esgotou as tentativas termina em erro).
  const interrupted = await ai.recoverInterrupted();
  if (interrupted > 0) log(`IA: ${interrupted} tarefas interrompidas pelo encerramento anterior foram tratadas`);
}
/** Último estado registrado no log, para avisar só quando muda. */
let aiState = '';
async function pollAi() {
  if (stopping) return;
  try {
    const state = await settings.status();
    const line = state.configured
      ? `IA ligada: ${state.provider} (${state.models?.fast} / ${state.models?.strong}), limite de US$ ${state.dailyBudgetUsd} por dia`
      : `IA desligada: ${state.problem}`;
    if (line !== aiState) log((aiState = line));
    const { started, swept, blocked, released, requeued, pruned } = await ai.tick();
    if (swept > 0) log(`IA: ${swept} vagas novas na fila da camada 1`);
    if (blocked > 0) log(`IA: limite de gasto do dia atingido, ${blocked} tarefas aguardando`);
    if (released > 0) log(`IA: ${released} tarefas liberadas`);
    if (requeued > 0) log(`IA: ${requeued} tarefas interrompidas voltaram para a fila`);
    if (pruned > 0) log(`IA: ${pruned} tarefas terminadas há mais de 30 dias foram apagadas`);
    if (started > 0) log(`IA: ${started} chamadas iniciadas`);
  } catch (e) {
    log(`erro na fila de IA: ${errorText(e)}`);
  }
}
const aiTimer = setInterval(() => void pollAi(), POLL_MS);
void pollAi();

// Fila de candidaturas: uma candidatura por vez, com timer próprio. Indisponível (HOST não local ou sem navegador) ela
// publica o motivo para a tela, registra-o no log e termina os comandos de conta do app com ele; desligada, só atende os
// comandos de conta. Liga e desliga pela aba Configurações, sem reiniciar.
const apply = createApplyRuntime(db, settings, { log });
await apply.recoverInterrupted();
async function pollApply() {
  if (stopping) return;
  try {
    const { commands, swept, started } = await apply.tick();
    if (commands > 0) log(`candidaturas: ${commands} comandos de conta atendidos`);
    if (swept > 0) log(`candidaturas: ${swept} vagas novas na fila`);
    if (started) log(`candidaturas: candidatura ${apply.inFlightId()} iniciada`);
  } catch (e) {
    log(`erro na fila de candidaturas: ${errorText(e)}`);
  }
}
const applyTimer = setInterval(() => void pollApply(), POLL_MS);
void pollApply();

/**
 * Redeploy/Ctrl+C: para de pegar runs da fila, espera um pouco os que estão em andamento e fecha o pool.
 * O que não terminar a tempo fica como "running" e vira erro no próximo start (failStaleRuns).
 */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(aiTimer);
  clearInterval(applyTimer);
  log(`${signal} recebido, encerrando`);
  setTimeout(() => process.exit(1), DRAIN_MS + 4_000).unref();
  const drained = await Promise.race([
    Promise.all([queue.idle(), ai.idle(), apply.idle()]).then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), DRAIN_MS)),
  ]);
  // Uma candidatura que não terminou a tempo volta à fila no próximo start; uma pega no envio vai ao dono conferir.
  if (!drained) log('runs ainda em andamento; serão marcados como erro no próximo start');
  try {
    await apply.close();
  } catch (e) {
    log(`erro ao fechar o navegador: ${errorText(e)}`);
  }
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
