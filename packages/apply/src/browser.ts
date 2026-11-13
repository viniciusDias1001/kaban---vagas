import { existsSync, readdirSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { FAKE_SITE_ORIGIN, fakeFixturePath, isFakeVariant } from './sites/fake';

export type BrowserChannel = 'chrome' | 'msedge';
/**
 * Um canal instalado (Chrome, Edge), o Opera GX (`opera-gx`: a versão mais nova instalada, procurada a cada abertura)
 * ou o executável de outro navegador baseado em Chromium.
 */
export type BrowserChoice = BrowserChannel | 'opera-gx' | { executablePath: string };

/** As subpastas de uma pasta; nenhuma se ela não existe. */
export type ListDirs = (dir: string) => string[];

const listDirs: ListDirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

const VERSION = /^\d+(\.\d+)*$/;

/** Compara nomes de versão ("114.0.5282.102") número a número. */
function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Em `root`, a pasta de versão mais alta (fora `skip`) que tem `exe`: o caminho do executável, ou null. */
function newestVersioned(
  path: typeof win32 | typeof posix, root: string, exe: string, exists: (p: string) => boolean, list: ListDirs, skip?: string,
): string | null {
  const versions = list(root)
    .filter((name) => VERSION.test(name) && name !== skip && exists(path.join(root, name, exe)))
    .sort(compareVersions);
  const newest = versions[versions.length - 1];
  return newest === undefined ? null : path.join(root, newest, exe);
}

/** Onde o Opera GX se instala, por usuário: `%LOCALAPPDATA%\Programs\Opera GX`. */
function operaGxRoot(env: NodeJS.ProcessEnv): string | null {
  return env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Programs', 'Opera GX') : null;
}

/** O `opera.exe` da pasta de versão mais alta em `%LOCALAPPDATA%\Programs\Opera GX\<versão>\`, ou null. */
export function newestOperaGx(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  list: ListDirs = listDirs,
): string | null {
  const root = operaGxRoot(env);
  return root ? newestVersioned(win32, root, 'opera.exe', exists, list) : null;
}

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

const isAbsolutePath = (p: string): boolean => win32.isAbsolute(p) || posix.isAbsolute(p);

/**
 * `APPLY_BROWSER` manda (`chrome`, `msedge`, `opera-gx` ou o caminho absoluto de um executável que exista); senão
 * procura Chrome e depois Edge nos caminhos padrão do sistema. Null = nenhum navegador utilizável; o porquê, para
 * mostrar ao dono, vem de `browserUnavailableReason`.
 */
export function detectBrowserChannel(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  list: ListDirs = listDirs,
): BrowserChoice | null {
  const wanted = env.APPLY_BROWSER?.trim();
  if (wanted) {
    if (wanted === 'chrome' || wanted === 'msedge') return wanted;
    if (wanted === 'opera-gx') return newestOperaGx(env, exists, list) ? 'opera-gx' : null;
    if (isAbsolutePath(wanted)) return exists(wanted) ? { executablePath: wanted } : null;
    return null;
  }
  for (const channel of ['chrome', 'msedge'] as const) {
    if (defaultPaths(channel, env, platform).some((p) => exists(p))) return channel;
  }
  return null;
}

const NOTHING_FOUND =
  'Nenhum navegador encontrado para a candidatura automática: instale o Chrome ou o Edge, ou defina APPLY_BROWSER '
  + '("chrome", "msedge", "opera-gx" ou o caminho do executável).';

/**
 * Por que `detectBrowserChannel` não acha navegador, numa frase para o dono; null quando acha. Com APPLY_BROWSER
 * apontando para um caminho que não existe mais (o Opera GX troca de pasta a cada atualização), procura na pasta
 * acima as outras pastas de versão com o mesmo executável e diz qual é a mais nova.
 */
export function browserUnavailableReason(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  list: ListDirs = listDirs,
): string | null {
  if (detectBrowserChannel(env, exists, platform, list) !== null) return null;
  const wanted = env.APPLY_BROWSER?.trim();
  if (!wanted) return NOTHING_FOUND;
  if (wanted === 'opera-gx') {
    const root = operaGxRoot(env);
    return `APPLY_BROWSER=opera-gx, mas o Opera GX não foi encontrado${root ? ` em "${root}"` : ''}: instale-o ou aponte APPLY_BROWSER para outro navegador.`;
  }
  if (!isAbsolutePath(wanted)) {
    return `APPLY_BROWSER="${wanted}" não é reconhecido: use chrome, msedge, opera-gx ou o caminho absoluto do executável.`;
  }
  const path = posix.isAbsolute(wanted) ? posix : win32;
  const versionDir = path.dirname(wanted);
  const sibling = VERSION.test(path.basename(versionDir))
    ? newestVersioned(path, path.dirname(versionDir), path.basename(wanted), exists, list, path.basename(versionDir))
    : null;
  if (sibling) {
    return `APPLY_BROWSER aponta para "${wanted}", que não existe mais; a versão mais nova encontrada está em "${sibling}". `
      + 'Atualize APPLY_BROWSER para esse caminho (no Opera GX, APPLY_BROWSER=opera-gx acompanha as atualizações sozinho).';
  }
  return `APPLY_BROWSER aponta para "${wanted}", que não existe: confira o caminho do executável.`;
}

export type LaunchContext = (userDataDir: string) => Promise<BrowserContext>;

export interface RealLaunchOptions {
  serviceWorkers?: 'allow' | 'block';
  /** Acha o executável do Opera GX a cada abertura (padrão: `newestOperaGx()`). */
  resolveOperaGx?: () => string | null;
}

/**
 * O navegador escolhido, perfil persistente, sempre com janela. Importa `playwright` só ao ser chamado.
 * `serviceWorkers` só entra na chamada quando informado (o padrão do Playwright é `allow`). Com `opera-gx`, o
 * executável é procurado de novo a cada abertura: uma atualização do navegador entre duas aberturas é seguida.
 */
export function realLaunch(choice: BrowserChoice, options: RealLaunchOptions = {}): LaunchContext {
  return async (userDataDir) => {
    let target: { channel: BrowserChannel } | { executablePath: string };
    if (choice === 'opera-gx') {
      const executablePath = (options.resolveOperaGx ?? (() => newestOperaGx()))();
      if (!executablePath) {
        throw new Error(browserUnavailableReason({ ...process.env, APPLY_BROWSER: 'opera-gx' }) ?? 'O Opera GX não foi encontrado.');
      }
      target = { executablePath };
    } else {
      target = typeof choice === 'string' ? { channel: choice } : { executablePath: choice.executablePath };
    }
    const { chromium } = await import('playwright');
    return chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...target,
      ...(options.serviceWorkers ? { serviceWorkers: options.serviceWorkers } : {}),
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
  // Sobe a cada `close()`: uma abertura em andamento que termina depois dele descarta o que abriu.
  let epoch = 0;

  async function open(): Promise<Page> {
    const mine = epoch;
    const ctx = await opts.launch(opts.userDataDir);
    if (mine !== epoch) {
      await ctx.close().catch(() => {});
      throw new Error('a sessão do navegador foi fechada durante a abertura');
    }
    context = ctx;
    // Fechar a janela (ou cair o navegador) volta a sessão ao estado fechado; a próxima `page()` abre de novo.
    ctx.on('close', () => {
      if (context === ctx) { context = null; current = null; }
    });
    // Alguns navegadores abrem uma aba inicial própria: a sessão cria a sua e nunca usa `pages()[0]`.
    const page = await ctx.newPage();
    if (mine !== epoch) {
      await ctx.close().catch(() => {});
      throw new Error('a sessão do navegador foi fechada durante a abertura');
    }
    current = page;
    return page;
  }

  async function replacePage(ctx: BrowserContext): Promise<Page> {
    const page = await ctx.newPage();
    current = page;
    return page;
  }

  return {
    async page() {
      usedAt = now();
      if (context && current && !current.isClosed()) return current;
      if (!opening) {
        const p: Promise<Page> = (context ? replacePage(context) : open()).finally(() => {
          if (opening === p) opening = null;
        });
        opening = p;
      }
      return opening;
    },
    async bringToFront() {
      if (current && !current.isClosed()) await current.bringToFront();
    },
    async close() {
      epoch += 1;
      const ctx = context;
      context = null;
      current = null;
      opening = null;
      await ctx?.close().catch(() => {});
    },
    isOpen: () => context !== null,
    lastUsedAt: () => usedAt,
  };
}
