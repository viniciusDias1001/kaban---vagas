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

/** Só o nome: sem esquema, porta, caminho nem ponto final. Vazio quando não sobra um nome válido. */
function bareHostname(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '').replace(/\.$/, '');
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name) ? name : '';
}

/**
 * Nomes de host que a API aceita no cabeçalho `Host` ALÉM dos locais (`localhost`, `host.docker.internal` e
 * qualquer IP), que valem sempre. Ver a trava de `Host` em app.ts (proteção contra DNS rebinding).
 * - `ALLOWED_HOSTS`: nomes separados por vírgula (`kanban.exemplo.com,outro.exemplo.com`). Porta, esquema e
 *   caminho são ignorados. É o que um deploy atrás de um domínio próprio precisa definir.
 * - No Railway nada precisa ser definido: o domínio público (`RAILWAY_PUBLIC_DOMAIN`), o privado
 *   (`RAILWAY_PRIVATE_DOMAIN`) e `healthcheck.railway.app` (o `Host` das requisições de healthcheck) entram sozinhos.
 */
export function resolveAllowedHosts(env: Env = process.env): string[] {
  const listed = (env.ALLOWED_HOSTS ?? '').split(',');
  const railway = [env.RAILWAY_PUBLIC_DOMAIN, env.RAILWAY_PRIVATE_DOMAIN].filter((d): d is string => !!d?.trim());
  if (railway.length > 0) railway.push('healthcheck.railway.app');
  return [...new Set([...listed, ...railway].map(bareHostname).filter(Boolean))];
}

/**
 * Diretório do web buildado a servir, ou undefined quando não há build (dev: o Vite serve o web e faz
 * proxy de /api). `WEB_DIST` aponta para outro diretório; sem ela vale `apps/web/dist`.
 */
export function resolveWebDist(env: Env = process.env, fallback: string = DEFAULT_WEB_DIST): string | undefined {
  const dir = env.WEB_DIST || fallback;
  return existsSync(join(dir, 'index.html')) ? dir : undefined;
}
