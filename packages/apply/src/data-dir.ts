import { homedir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import type { ShotKind } from '@kv/shared';

const APP_DIR = 'kanban-vagas';

/**
 * `APPLY_DATA_DIR` manda. Senão: Windows `%LOCALAPPDATA%\kanban-vagas`; macOS
 * `~/Library/Application Support/kanban-vagas`; demais `${XDG_DATA_HOME:-~/.local/share}/kanban-vagas`.
 */
export function applyDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.APPLY_DATA_DIR) return env.APPLY_DATA_DIR;
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), APP_DIR);
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', APP_DIR);
  return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), APP_DIR);
}

export function browserProfileDir(dataDir: string): string {
  return join(dataDir, 'browser');
}

/**
 * O perfil do Chromium do Playwright que abre o site de teste (`FAKE_APPLY_SITE=1`), separado do perfil do navegador
 * real do dono: o mesmo perfil em dois navegadores dá conflito de versão e de trava.
 */
export function fakeBrowserProfileDir(dataDir: string): string {
  return join(dataDir, 'browser-fake');
}

export function shotPath(dataDir: string, applicationId: number, kind: ShotKind): { absolute: string; relative: string } {
  const rel = `shots/${applicationId}/${kind}.jpg`;
  return { absolute: join(dataDir, rel), relative: rel };
}

/** O formato que `shotPath` grava: `shots/<id da candidatura>/<arquivo>`. */
const SHOT = /^shots\/\d+\/[^/]+$/;

/**
 * Caminho absoluto de uma foto gravada, ou null se o relativo não tem o formato de `shotPath` (só fotos: nunca o
 * perfil do navegador, os PDFs ou outro arquivo da pasta de dados) ou sai da pasta de dados.
 */
export function resolveShot(dataDir: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || posix.isAbsolute(rel) || win32.isAbsolute(rel)) return null;
  if (!SHOT.test(rel)) return null;
  // Os caminhos gravados usam só "/": barra invertida, letra de unidade e segmentos ".." nunca são legítimos.
  if (rel.includes('\\')|| rel.includes(':') || rel.split('/').includes('..')) return null;
  const root = resolve(dataDir);
  const abs = resolve(root, rel);
  const back = relative(root, abs);
  if (!back || back === '..' || back.startsWith('..' + sep) || isAbsolute(back)) return null;
  return join(dataDir, rel);
}
