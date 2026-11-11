import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Env = Record<string, string | undefined>;

/** Onde o `pnpm --filter @kv/web build` grava o web buildado. */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

/**
 * Endereço em que a API escuta. Local: 127.0.0.1:3333 (ou `API_PORT`). Em container/Railway: `HOST=0.0.0.0`
 * e a porta que a plataforma injeta em `PORT`, que tem precedência sobre `API_PORT`.
 */
export function resolveListen(env: Env = process.env): { host: string; port: number } {
  const name = env.PORT ? 'PORT' : env.API_PORT ? 'API_PORT' : undefined;
  const port = name ? Number(env[name]) : 3333;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name} inválida: "${env[name!]}" não é uma porta TCP.`);
  }
  return { host: env.HOST || '127.0.0.1', port };
}

/**
 * Diretório do web buildado a servir, ou undefined quando não há build (dev: o Vite serve o web e faz
 * proxy de /api). `WEB_DIST` aponta para outro diretório; sem ela vale `apps/web/dist`.
 */
export function resolveWebDist(env: Env = process.env, fallback: string = DEFAULT_WEB_DIST): string | undefined {
  const dir = env.WEB_DIST || fallback;
  return existsSync(join(dir, 'index.html')) ? dir : undefined;
}
