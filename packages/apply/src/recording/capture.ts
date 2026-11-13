import { createHash } from 'node:crypto';
import type { BrowserContext, Page, Response } from 'playwright';

// O código que roda dentro da página é texto, não função: o transpilador dos scripts (tsx) injeta auxiliares
// em funções serializadas, e eles não existem no navegador.

export interface ReplayCapture {
  /** URL → nome de arquivo relativo (o documento é `document.html`). */
  routes: Record<string, string>;
  files: Record<string, Buffer>;
}

const REPLAY_TYPES = new Set(['document', 'script', 'stylesheet', 'fetch', 'xhr']);
const TEXT_TYPE = /html|javascript|ecmascript|css|json|xml|^text\//i;
const SETTLE_MS = 2000;

/** Os dois últimos rótulos do host: `cdn.form.test` e `form.test` são o mesmo site. */
function registrableDomain(host: string): string {
  return host.split('.').slice(-2).join('.');
}

function extensionFor(url: URL, contentType: string): string {
  if (/javascript|ecmascript/i.test(contentType)) return '.js';
  if (/css/i.test(contentType)) return '.css';
  if (/json/i.test(contentType)) return '.json';
  if (/html/i.test(contentType)) return '.html';
  const m = /\.([a-z0-9]{1,5})$/i.exec(url.pathname);
  return m ? `.${m[1].toLowerCase()}` : '.txt';
}

function fileNameFor(url: URL, contentType: string): string {
  const hash = createHash('sha1').update(url.href).digest('hex').slice(0, 8);
  const base = (url.pathname.split('/').filter(Boolean).pop() ?? 'index').replace(/\.[a-z0-9]{1,5}$/i, '');
  const safe = base.replace(/[^\w-]+/g, '_').slice(0, 40) || 'file';
  return `${safe}-${hash}${extensionFor(url, contentType)}`;
}

/** Aborta toda requisição que não é GET, na página ou no contexto inteiro. Deixa as demais para o próximo tratador. */
export async function blockWrites(target: Page | BrowserContext): Promise<void> {
  await target.route('**/*', (route) => (route.request().method() === 'GET' ? route.fallback() : route.abort()));
}

/** Há um cookie com esse nome, não vazio, no domínio (ou em um subdomínio dele)? */
export function hasSessionCookie(cookies: Array<{ name: string; domain: string; value: string }>, name: string, domain: string): boolean {
  return cookies.some((c) => c.name === name && c.value !== '' && c.domain.replace(/^\./, '').endsWith(domain));
}

/**
 * Navega até `url`, espera a rede parar (mais 2 s) e guarda toda resposta GET bem-sucedida de documento, script,
 * estilo, `fetch` e `xhr` do mesmo domínio registrável. Toda requisição que não é GET é abortada.
 */
export async function captureReplay(page: Page, url: string): Promise<ReplayCapture> {
  const site = registrableDomain(new URL(url).hostname);
  await blockWrites(page);

  const pending: Array<Promise<{ url: URL; contentType: string; body: Buffer; isDocument: boolean } | null>> = [];
  const onResponse = (response: Response) => {
    const request = response.request();
    if (request.method() !== 'GET' || !response.ok() || !REPLAY_TYPES.has(request.resourceType())) return;
    const target = new URL(response.url());
    if (registrableDomain(target.hostname) !== site) return;
    const contentType = response.headers()['content-type'] ?? '';
    if (!TEXT_TYPE.test(contentType)) return;
    const isDocument = request.resourceType() === 'document' && request.frame() === page.mainFrame();
    pending.push(
      response.body().then(
        (body) => ({ url: target, contentType, body, isDocument }),
        () => null,
      ),
    );
  };
  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(SETTLE_MS);
  } finally {
    page.off('response', onResponse);
  }

  const routes: Record<string, string> = {};
  const files: Record<string, Buffer> = {};
  for (const item of await Promise.all(pending)) {
    if (!item) continue;
    const key = item.url.href;
    if (routes[key]) continue;
    const name = item.isDocument ? 'document.html' : fileNameFor(item.url, item.contentType);
    routes[key] = name;
    files[name] = item.body;
  }
  return { routes, files };
}

export const DEFAULT_KEEP = 'main, [role="main"], [role="dialog"]';

const SNAPSHOT_SOURCE = `(keep) => {
  const REMOVE = new Set(['SCRIPT', 'CODE', 'IFRAME', 'NOSCRIPT', 'META', 'LINK']);
  const matches = new Set(document.querySelectorAll(keep));
  if (matches.size === 0) throw new Error('nenhum elemento casa com ' + keep);

  const hasKept = (el) => { for (const m of matches) if (el === m || el.contains(m)) return true; return false; };
  const hide = (live, clone) => {
    const css = getComputedStyle(live);
    if (css.display === 'none' || css.visibility === 'hidden') {
      const style = clone.getAttribute('style');
      clone.setAttribute('style', (style ? style.replace(/;?\\s*$/, ';') : '') + 'display:none');
    }
  };
  const clean = (clone) => {
    for (const child of Array.from(clone.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) child.remove();
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if (REMOVE.has(child.tagName)) child.remove();
        else clean(child);
      }
    }
  };
  // Percorre o original e a cópia em paralelo: o estilo calculado só existe no original.
  const freeze = (live, clone) => {
    hide(live, clone);
    for (let i = 0; i < live.children.length; i++) freeze(live.children[i], clone.children[i]);
  };
  const build = (el) => {
    if (REMOVE.has(el.tagName)) return null;
    if (matches.has(el)) {
      const clone = el.cloneNode(true);
      freeze(el, clone);
      clean(clone);
      return clone;
    }
    if (!hasKept(el)) return null;
    const clone = el.cloneNode(false);
    hide(el, clone);
    for (const child of el.children) {
      const built = build(child);
      if (built) clone.appendChild(built);
    }
    return clone;
  };

  const body = build(document.body) || document.createElement('body');
  const title = document.createElement('title');
  title.textContent = document.title;
  const lang = document.documentElement.getAttribute('lang');
  const html = document.createElement('html');
  if (lang) html.setAttribute('lang', lang);
  const head = document.createElement('head');
  head.appendChild(title);
  html.appendChild(head);
  html.appendChild(body);
  return '<!doctype html>\\n' + html.outerHTML + '\\n';
}`;

/**
 * O DOM já renderizado, sem scripts: só os elementos de `keep` com seus ancestrais. O que a página escondia
 * (`display: none` ou `visibility: hidden` calculado) fica escondido por `style` na cópia. Lança se `keep` não acha nada.
 */
export function captureSnapshot(page: Page, keep: string = DEFAULT_KEEP): Promise<string> {
  return page.evaluate(`(${SNAPSHOT_SOURCE})(${JSON.stringify(keep)})`) as Promise<string>;
}

const SUBMIT_TEXT = '/enviar candidatura|submit application/i';

const BLOCK_SUBMIT_SOURCE = `(() => {
  if (window.__applyBlockSubmit) return;
  window.__applyBlockSubmit = true;
  const pattern = ${SUBMIT_TEXT};
  const textOf = (el) => [el.textContent, el.value, el.getAttribute && el.getAttribute('aria-label')].filter(Boolean).join(' ');
  const BUTTON = 'button, [role="button"], input[type="submit"], input[type="button"], a';
  // O alvo do clique é reposicionado para o hospedeiro quando o botão está em um shadow root: o caminho
  // composto traz o botão de verdade.
  const isSubmitClick = (e) => {
    for (const el of e.composedPath()) {
      if (el.nodeType === 1 && el.matches && el.matches(BUTTON)) return pattern.test(textOf(el));
    }
    return false;
  };
  window.addEventListener('click', (e) => {
    if (isSubmitClick(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // Uma sessão de gravação nunca precisa enviar formulário: Enter em campo único, requestSubmit() e botão com
  // outro rótulo também são barrados.
  window.addEventListener('submit', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
})()`;

/**
 * Instala, em toda página do contexto (a de agora e as futuras), um tratador que barra o clique em botão cujo
 * texto casa `/enviar candidatura|submit application/i` (também dentro de shadow root) e todo evento `submit`
 * de formulário. Se não conseguir instalar em uma página já aberta, lança: a gravação não segue sem a proteção.
 */
export async function blockSubmitClicks(page: Page): Promise<void> {
  await page.context().addInitScript(BLOCK_SUBMIT_SOURCE);
  for (const open of page.context().pages()) {
    try {
      await open.evaluate(BLOCK_SUBMIT_SOURCE);
    } catch (err) {
      throw new Error(`não foi possível instalar a proteção contra envio em ${open.url()}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
