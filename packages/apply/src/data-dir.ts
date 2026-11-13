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

export function shotPath(dataDir: string, applicationId: number, kind: ShotKind): { absolute: string; relative: string } {
  const rel = `shots/${applicationId}/${kind}.jpg`;
  return { absolute: join(dataDir, rel), relative: rel };
}

/** Caminho absoluto de uma foto gravada, ou null se o relativo sai da pasta de dados. */
export function resolveShot(dataDir: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || posix.isAbsolute(rel) || win32.isAbsolute(rel)) return null;
  // Os caminhos gravados usam só "/": barra invertida, letra de unidade e segmentos ".." nunca são legítimos.
  if (rel.includes('\\')|| rel.includes(':') || rel.split('/').includes('..')) return null;
  const root = resolve(dataDir);
  const abs = resolve(root, rel);
  const back = relative(root, abs);
  if (!back || back === '..' || back.startsWith('..' + sep) || isAbsolute(back)) return null;
  return join(dataDir, rel);
}
