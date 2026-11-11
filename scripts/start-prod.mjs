#!/usr/bin/env node
// Start de produção: um container, três passos.
//
//   1. aplica as migrations pendentes (uma vez, e espera terminar; se o banco ainda não responde, insiste ~5 min);
//   2. sobe a API (que também serve o web buildado) e o worker como processos filhos;
//   3. se um dos dois sair, derruba o outro e sai com código != 0, para a plataforma reiniciar o container.
//
// Migrations sem corrida: só este script as roda, em série, antes de existir qualquer filho. API e worker
// nunca migram: eles só conferem que as tabelas existem (`assertDbReady`). Isso vale para UMA réplica do
// container; com mais de uma, duas réplicas poderiam migrar ao mesmo tempo (e o worker buscaria em dobro).
//
// Os filhos são `node --import tsx <arquivo>` e não `pnpm ...`: assim o SIGTERM chega direto no processo
// que precisa fechar o servidor e o pool, e a imagem não depende do pnpm em runtime.
//
// Uso: node scripts/start-prod.mjs   (precisa de DATABASE_URL; para servir o web, `pnpm --filter @kv/web build` antes)

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Tempo para os filhos encerrarem sozinhos depois do SIGTERM, antes do SIGKILL (o `docker stop` dá 10 s). */
const KILL_AFTER_MS = 9_000;

const log = (msg) => console.log(`[start] ${msg}`);

// O tsx é dependência de runtime do @kv/api; resolver por lá funciona qualquer que seja o cwd.
const tsx = pathToFileURL(createRequire(join(ROOT, 'apps/api/package.json')).resolve('tsx')).href;

/** Sobe `node --import tsx <entry>` repassando a saída linha a linha com o prefixo `name |`. */
function start(name, entry, args = []) {
  const child = spawn(process.execPath, ['--import', tsx, join(ROOT, entry), ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `${name.padEnd(7)}| `;
  createInterface({ input: child.stdout }).on('line', (line) => console.log(prefix + line));
  createInterface({ input: child.stderr }).on('line', (line) => console.error(prefix + line));
  /** Resolve quando o processo terminou E a saída dele já foi toda repassada. */
  const closed = new Promise((resolve) => {
    child.once('error', (err) => {
      console.error(`${prefix}não foi possível iniciar: ${err.message}`);
      resolve({ code: 1, signal: null });
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { name, child, closed };
}

const describeExit = ({ code, signal }) => (signal ? `sinal ${signal}` : `código ${code}`);
const isRunning = (child) => child.exitCode === null && child.signalCode === null;

// --- 1. migrations ---------------------------------------------------------------------------
let stopSignal = null;
let current = [];
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopSignal) return;
    stopSignal = signal;
    log(`${signal} recebido, encerrando ${current.map((c) => c.name).join(' e ') || 'o start'}`);
    stopAll(signal);
  });
}

/** Pede para os filhos vivos encerrarem; quem não sair em KILL_AFTER_MS leva SIGKILL. */
function stopAll(signal = 'SIGTERM') {
  for (const { child } of current) if (isRunning(child)) child.kill(signal);
  setTimeout(() => {
    for (const { name, child } of current) {
      if (!isRunning(child)) continue;
      log(`${name} não encerrou em ${KILL_AFTER_MS / 1000} s, SIGKILL`);
      child.kill('SIGKILL');
    }
  }, KILL_AFTER_MS).unref();
}

// `--wait`: se o Postgres ainda está subindo (redeploy correndo com o banco), as migrations esperam por ele
// até ~5 min em vez de derrubar o container; API e worker fazem a mesma espera no start deles.
const migration = start('migrate', 'packages/db/src/migrate-cli.ts', ['--wait']);
current = [migration];
const migrated = await migration.closed;
if (stopSignal) process.exit(0);
if (migrated.code !== 0) {
  log(`migrations falharam (${describeExit(migrated)}); nada foi iniciado`);
  process.exit(1);
}

// --- 2. API + worker -------------------------------------------------------------------------
current = [start('api', 'apps/api/src/index.ts'), start('worker', 'apps/worker/src/index.ts')];
log('api e worker iniciados');

// --- 3. um caiu => derruba o outro e sai != 0 ------------------------------------------------
const first = await Promise.race(current.map((c) => c.closed.then((exit) => ({ name: c.name, exit }))));
const requested = stopSignal !== null;
if (!requested) {
  log(`${first.name} saiu sozinho (${describeExit(first.exit)}); encerrando o container`);
  stopAll();
}
const exits = await Promise.all(current.map((c) => c.closed));

if (requested && exits.every((e) => e.code === 0)) {
  log('encerrado');
  process.exit(0);
}
if (requested) log(`encerrado com falha (${current.map((c, i) => `${c.name}: ${describeExit(exits[i])}`).join(', ')})`);
// Saída não pedida de um filho é sempre falha, mesmo com código 0: os dois deveriam rodar para sempre.
process.exit(1);
