import type { ApplySite, BrowserSession } from '@kv/apply';
import { finishApplyCommand, updateSiteState, type ApplyCommandRow, type Db } from '@kv/db';

export interface CommandDeps {
  db: Db;
  sites: () => ApplySite[];
  browser: BrowserSession;
  now?: () => number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Os cookies do site são os do domínio da página de login e dos seus subdomínios (sem o `www.`). */
function cookieDomain(loginUrl: string): RegExp {
  const host = new URL(loginUrl).hostname.replace(/^www\./, '');
  return new RegExp(`(^|\\.)${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

function siteOf(deps: CommandDeps, command: ApplyCommandRow): ApplySite {
  const site = deps.sites().find((s) => s.id === command.site);
  if (!site) throw new Error(`o site "${command.site}" não está cadastrado neste worker`);
  return site;
}

function loginUrlOf(site: ApplySite): string {
  if (!site.needsLogin || !site.loginUrl) throw new Error('este site não pede login');
  return site.loginUrl;
}

async function execute(deps: CommandDeps, command: ApplyCommandRow, now: () => number): Promise<string> {
  switch (command.kind) {
    case 'open_login': {
      const url = loginUrlOf(siteOf(deps, command));
      const page = await deps.browser.page();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await deps.browser.bringToFront();
      return 'página de login aberta';
    }
    case 'check_session': {
      const site = siteOf(deps, command);
      const session = await site.sessionState(await deps.browser.page());
      await updateSiteState(deps.db, site.id, { session, sessionCheckedAt: now() });
      return session === 'logged_in' ? 'conectado' : 'desconectado';
    }
    case 'logout': {
      const site = siteOf(deps, command);
      const domain = cookieDomain(loginUrlOf(site));
      const page = await deps.browser.page();
      await page.context().clearCookies({ domain });
      await updateSiteState(deps.db, site.id, { session: 'logged_out', sessionCheckedAt: now() });
      return 'sessão apagada';
    }
    case 'close_browser':
      await deps.browser.close();
      return 'navegador fechado';
    default:
      throw new Error(`comando desconhecido: ${command.kind}`);
  }
}

/**
 * Executa um comando do app (já marcado `running` por `nextApplyCommand`) e grava o desfecho: `open_login` abre
 * `loginUrl` e traz a janela; `check_session` grava o estado em `apply_sites`; `logout` apaga os cookies do site;
 * `close_browser` fecha a janela. Um erro (site sem login, site não cadastrado, navegador) termina o comando em `error`.
 * Devolve o desfecho gravado.
 */
export async function runApplyCommand(deps: CommandDeps, command: ApplyCommandRow): Promise<{ ok: boolean; message: string }> {
  const now = deps.now ?? Date.now;
  let result: { ok: boolean; message: string };
  try {
    result = { ok: true, message: await execute(deps, command, now) };
  } catch (e) {
    result = { ok: false, message: errorText(e) };
  }
  await finishApplyCommand(deps.db, command.id, result, now());
  return result;
}
