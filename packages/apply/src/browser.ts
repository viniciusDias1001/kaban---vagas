import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { FAKE_SITE_ORIGIN, fakeFixturePath, isFakeVariant } from './sites/fake';

export type BrowserChannel = 'chrome' | 'msedge';
/** Um canal instalado (Chrome, Edge) ou o executável de outro navegador baseado em Chromium (ex.: Opera GX). */
export type BrowserChoice = BrowserChannel | { executablePath: string };

function defaultPaths(channel: BrowserChannel, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter((r): r is string => !!r);
    const rel = channel === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    return roots.map((r) => win32.join(r, ...rel));
  }
  if (platform === 'darwin') {
    return channel === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return channel === 'chrome'
    ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
    : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'];
}

/**
 * `APPLY_BROWSER` manda (`chrome`, `msedge` ou o caminho absoluto de um executável que exista); senão procura
 * Chrome e depois Edge nos caminhos padrão do sistema. Null = nenhum navegador utilizável.
 */
export function detectBrowserChannel(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): BrowserChoice | null {
  const wanted = env.APPLY_BROWSER?.trim();
  if (wanted) {
    if (wanted === 'chrome' || wanted === 'msedge') return wanted;
    if (win32.isAbsolute(wanted) || posix.isAbsolute(wanted)) return exists(wanted) ? { executablePath: wanted } : null;
    return null;
  }
  for (const channel of ['chrome', 'msedge'] as const) {
    if (defaultPaths(channel, env, platform).some((p) => exists(p))) return channel;
  }
  return null;
}

export type LaunchContext = (userDataDir: string) => Promise<BrowserContext>;

/** O navegador escolhido, perfil persistente, sempre com janela. Importa `playwright` só ao ser chamado. */
export function realLaunch(choice: BrowserChoice): LaunchContext {
  return async (userDataDir) => {
    const { chromium } = await import('playwright');
    return chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...(typeof choice === 'string' ? { channel: choice } : { executablePath: choice.executablePath }),
    });
  };
}

/** Chromium do Playwright, sem janela, com a rede cortada e `FAKE_SITE_ORIGIN` servido de `fixtures/fake`. */
export function fakeLaunch(): LaunchContext {
  return async (userDataDir) => {
    const { chromium } = await import('playwright');
    const context = await chromium.launchPersistentContext(userDataDir, { headless: true });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== FAKE_SITE_ORIGIN) return route.abort();
      const variant = url.searchParams.get('variant') ?? 'form';
      if (!isFakeVariant(variant)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ path: fakeFixturePath(variant), contentType: 'text/html; charset=utf-8' });
    });
    return context;
  };
}

export interface BrowserSession {
  /** A página única da sessão; abre o navegador na primeira chamada. */
  page(): Promise<Page>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
  /** Quando `page()` foi usada pela última vez. */
  lastUsedAt(): number;
}

export function createBrowserSession(opts: { userDataDir: string; launch: LaunchContext; now?: () => number }): BrowserSession {
  const now = opts.now ?? Date.now;
  let context: BrowserContext | null = null;
  let current: Page | null = null;
  let opening: Promise<Page> | null = null;
  let usedAt = 0;

  async function open(): Promise<Page> {
    const ctx = await opts.launch(opts.userDataDir);
    context = ctx;
    // Fechar a janela (ou cair o navegador) volta a sessão ao estado fechado; a próxima `page()` abre de novo.
    ctx.on('close', () => {
      if (context === ctx) { context = null; current = null; }
    });
    // Alguns navegadores abrem uma aba inicial própria: a sessão cria a sua e nunca usa `pages()[0]`.
    current = await ctx.newPage();
    return current;
  }

  return {
    async page() {
      usedAt = now();
      if (context && current && !current.isClosed()) return current;
      if (context && current?.isClosed()) {
        current = await context.newPage();
        return current;
      }
      opening ??= open().finally(() => { opening = null; });
      return opening;
    },
    async bringToFront() {
      if (current && !current.isClosed()) await current.bringToFront();
    },
    async close() {
      const ctx = context;
      context = null;
      current = null;
      await ctx?.close().catch(() => {});
    },
    isOpen: () => context !== null,
    lastUsedAt: () => usedAt,
  };
}
