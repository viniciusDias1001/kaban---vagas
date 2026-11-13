import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Pasta de dados da candidatura automática (`APPLY_DATA_DIR`) do servidor do e2e: perfil do navegador, currículos e
 * fotos. Fica na pasta temporária do sistema e nunca é a pasta de dados de verdade do dono (que guarda o perfil do
 * navegador dele): sem `APPLY_DATA_DIR`, a API e o worker usariam a pasta padrão.
 */
export const E2E_APPLY_DATA_DIR = join(tmpdir(), 'kanban-vagas-e2e-apply');

/** Apaga a pasta do e2e (só ela: o caminho é fixo, nunca lido do ambiente), para cada execução começar vazia. */
export function resetApplyDataDir(): void {
  rmSync(E2E_APPLY_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
