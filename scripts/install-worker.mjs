#!/usr/bin/env node
// Mantém o worker rodando sem a interface aberta (busca a cada hora cheia + fila de "Buscar agora").
//
//   node scripts/install-worker.mjs               instala (pnpm worker:install)
//   node scripts/install-worker.mjs --uninstall   remove  (pnpm worker:install -- --uninstall)
//
// Windows: grava worker.cmd na raiz do repo (ignorado pelo git) e registra a tarefa agendada
//          KanbanVagasWorker, que roda esse arquivo a cada logon do usuário atual. Não precisa de
//          administrador: `schtasks /Create /SC ONLOGON` dá "Acesso negado" sem elevação, então a tarefa é
//          registrada pelo PowerShell (Register-ScheduledTask); consulta e remoção usam o schtasks.
// Linux/macOS: só imprime as instruções do pm2; nada é instalado.
//
// O worker lê DATABASE_URL de <raiz do repo>/.env (ou do ambiente do processo): crie o .env antes.

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASK = 'KanbanVagasWorker';
const CMD_PATH = join(ROOT, 'worker.cmd');
const PM2_NAME = 'kanban-vagas-worker';

const uninstall = process.argv.slice(2).includes('--uninstall');

/** Roda o schtasks com uma lista de argumentos (sem shell). Devolve true se terminou com código 0. */
function schtasks(args, { quiet = false } = {}) {
  try {
    execFileSync('schtasks', args, { stdio: quiet ? 'ignore' : 'inherit', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Registra a tarefa de logon pelo PowerShell. Caminhos e nomes vão por variáveis de ambiente e o script por
 * -EncodedCommand (UTF-16LE em base64): nada passa por aspas, então o caminho do repo pode ter espaços.
 */
function registerTask() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'", // sem isto o PowerShell despeja o progresso (CLIXML) no stderr
    '$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name',
    '$action = New-ScheduledTaskAction -Execute $env:KV_WORKER_CMD -WorkingDirectory $env:KV_ROOT',
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user',
    // Sem isto o Windows encerra a tarefa após 72 h; o worker tem de rodar para sempre (e em notebook na bateria).
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)',
    'Register-ScheduledTask -TaskName $env:KV_TASK -Action $action -Trigger $trigger -Settings $settings -User $user -Force | Out-Null',
  ].join('\n');
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: 'inherit', windowsHide: true, env: { ...process.env, KV_WORKER_CMD: CMD_PATH, KV_ROOT: ROOT, KV_TASK: TASK } },
    );
    return true;
  } catch {
    return false;
  }
}

function warnIfNoDatabaseUrl() {
  if (existsSync(join(ROOT, '.env')) || process.env.DATABASE_URL) return;
  console.warn('');
  console.warn('Aviso: não há .env na raiz do repo. O worker precisa de DATABASE_URL e a lê de:');
  console.warn(`  ${join(ROOT, '.env')}`);
  console.warn('Copie o .env.example para .env e ajuste a URL do banco (e rode `pnpm db:migrate`) antes de iniciar.');
}

function installWindows() {
  // %~dp0 = pasta do próprio worker.cmd (com barra final): o cd não depende de onde a tarefa foi iniciada.
  // Se mover o repo de pasta, rode a instalação de novo.
  // O worker não migra o banco: `pnpm db:migrate` precisa ter rodado antes (o `pnpm dev` já faz isso).
  writeFileSync(CMD_PATH, '@echo off\r\ncd /d "%~dp0"\r\ncall pnpm --filter @kv/worker start\r\n');

  if (!registerTask()) {
    rmSync(CMD_PATH, { force: true });
    console.error(`Não foi possível criar a tarefa "${TASK}". worker.cmd foi removido.`);
    process.exit(1);
  }

  console.log('');
  console.log(`Tarefa "${TASK}" criada: o worker inicia a cada logon (uma janela de console fica aberta; fechá-la para o worker).`);
  console.log(`Arquivo de início: ${CMD_PATH}`);
  console.log('');
  console.log('Iniciar agora, sem sair da sessão:');
  console.log(`  schtasks /Run /TN ${TASK}`);
  console.log('Conferir:');
  console.log(`  schtasks /Query /TN ${TASK}`);
  console.log('Remover (apaga a tarefa e o worker.cmd):');
  console.log('  pnpm worker:install -- --uninstall');
  console.log('');
  console.log('O worker lê DATABASE_URL de:');
  console.log(`  ${join(ROOT, '.env')}`);
  warnIfNoDatabaseUrl();
}

function uninstallWindows() {
  const exists = schtasks(['/Query', '/TN', TASK], { quiet: true });
  if (exists) {
    schtasks(['/End', '/TN', TASK], { quiet: true }); // se estiver rodando, para; senão não faz nada
    if (!schtasks(['/Delete', '/TN', TASK, '/F'])) {
      console.error(`Não foi possível remover a tarefa "${TASK}".`);
      process.exit(1);
    }
    console.log(`Tarefa "${TASK}" removida.`);
  } else {
    console.log(`A tarefa "${TASK}" não existe; nada a remover.`);
  }
  if (existsSync(CMD_PATH)) {
    rmSync(CMD_PATH, { force: true });
    console.log('worker.cmd removido.');
  }
}

function printPm2(remove) {
  if (remove) {
    console.log('No Linux e macOS nada é instalado por este script. Para remover o worker do pm2:');
    console.log(`  pm2 delete ${PM2_NAME} && pm2 save`);
    return;
  }
  console.log('No Linux e macOS, use o pm2 (este script não instala nada):');
  console.log('');
  console.log('  npm install -g pm2');
  console.log(`  cd "${ROOT}"`);
  console.log(`  pm2 start "pnpm --filter @kv/worker start" --name ${PM2_NAME}`);
  console.log('  pm2 save && pm2 startup    # `pm2 startup` imprime um comando para você rodar uma vez');
  console.log('');
  console.log('Remover:');
  console.log(`  pm2 delete ${PM2_NAME} && pm2 save`);
  console.log('');
  console.log('O worker lê DATABASE_URL de:');
  console.log(`  ${join(ROOT, '.env')}`);
  warnIfNoDatabaseUrl();
}

if (process.platform === 'win32') {
  if (uninstall) uninstallWindows();
  else installWindows();
} else {
  printPm2(uninstall);
}
