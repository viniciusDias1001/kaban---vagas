/**
 * Gravador de fixtures. Nunca clica em nada e nunca envia nada. Tudo o que é gravado passa por `scrubFixture` e
 * por `findLeaks`: se sobrar algo, nada é gravado e o processo sai com código 1.
 *
 *   pnpm exec tsx packages/apply/scripts/record-fixture.ts <modo> ...
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Page } from 'playwright';
import { applyDataDir, browserProfileDir } from '../src/data-dir';
import { detectBrowserChannel, realLaunch } from '../src/browser';
import {
  blockSubmitClicks, blockWrites, captureReplay, captureSnapshot, DEFAULT_KEEP, hasSessionCookie, newRecordingPage,
} from '../src/recording/capture';
import {
  findIdentityLeaks, findLeaks, NO_IDENTITY, scrubFixture, type FixtureKind, type ScrubIdentity,
} from '../src/recording/scrub';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RECORDED = /\.(html|json|js|css)$/i;

const USAGE = `Uso: pnpm exec tsx packages/apply/scripts/record-fixture.ts <modo> ...

Modos:
  json      --url <api> --out <arquivo.json>
  replay    --url <url> --out <pasta>
  snapshot  --url <url> --out <arquivo.html> [--keep <seletor>]
  profile   --staging <pasta fora do repositório>
            Abre o perfil do navegador do dono, que já precisa estar com a sessão aberta (entre no site antes, pelo
            uso normal). Só leitura: toda requisição que não é GET é abortada e todo envio de formulário é barrado,
            então algumas páginas podem não avançar. Isso é intencional. Service workers ficam bloqueados.
  scrub    --from <staging> --to <pasta de fixtures> --identity <json fora do repositório>
`;

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

function real(path: string): string {
  const abs = resolve(path);
  // Resolve links simbólicos do trecho que já existe, para um atalho não escapar da checagem.
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(existing.slice(dirname(existing).length + 1));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

function insideRepo(path: string): boolean {
  const rel = relative(realpathSync(REPO_ROOT), real(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function outsideRepo(flag: string, path: string | undefined): string {
  if (!path) fail(`falta ${flag}`);
  if (insideRepo(path)) fail(`${flag} não pode ficar dentro do repositório: ${path}`);
  return resolve(path);
}

function required(flag: string, value: string | undefined): string {
  if (!value) fail(`falta ${flag}`);
  return value;
}

function kindOf(file: string): FixtureKind {
  return /\.(js|css)$/i.test(file) ? 'asset' : 'markup';
}

function loadIdentity(path: string | undefined): ScrubIdentity {
  if (!path) return NO_IDENTITY;
  const file = outsideRepo('--identity', path);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ScrubIdentity>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { names: list(raw.names), emails: list(raw.emails), phones: list(raw.phones), extra: list(raw.extra) };
}

interface Output { path: string; content: string | Buffer }

/**
 * Limpa cada arquivo e confere com `findLeaks`. Se algum ainda vaza, não grava nenhum e sai com código 1,
 * listando a regra e o trecho.
 */
function writeScrubbed(outputs: Output[], identity: ScrubIdentity): void {
  const cleaned = outputs.map((o) => {
    const kind = kindOf(o.path);
    const text = scrubFixture(o.content.toString('utf8'), identity, kind);
    const leaks: Array<{ rule: string; sample: string }> = findLeaks(text, kind);
    if (kind === 'markup') leaks.push(...findIdentityLeaks(text, identity));
    return { path: o.path, text, leaks };
  });
  const leaking = cleaned.filter((c) => c.leaks.length > 0);
  if (leaking.length) {
    for (const c of leaking) {
      for (const leak of c.leaks) console.error(`vazamento [${leak.rule}] em ${c.path}: ${leak.sample}`);
    }
    console.error('nada foi gravado: confira a identidade informada ou revise a página.');
    process.exit(1);
  }
  for (const c of cleaned) {
    mkdirSync(dirname(c.path), { recursive: true });
    writeFileSync(c.path, c.text, 'utf8');
    console.log('gravado', c.path);
  }
}

async function withHeadlessPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    // Sem service worker e com toda requisição que não é GET abortada (o snapshot também, não só o replay).
    return await run(await newRecordingPage(browser));
  } finally {
    await browser.close();
  }
}

async function recordJson(values: Record<string, string | undefined>): Promise<void> {
  const url = required('--url', values.url);
  const out = resolve(required('--out', values.out));
  const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.ok) fail(`${url} respondeu ${response.status}`);
  const text = JSON.stringify(JSON.parse(await response.text()), null, 2) + '\n';
  writeScrubbed([{ path: out, content: text }], loadIdentity(values.identity));
}

async function recordReplay(values: Record<string, string | undefined>): Promise<void> {
  const url = required('--url', values.url);
  const out = resolve(required('--out', values.out));
  const capture = await withHeadlessPage((page) => captureReplay(page, url));
  const outputs: Output[] = Object.entries(capture.files).map(([name, content]) => ({ path: join(out, name), content }));
  outputs.push({ path: join(out, 'routes.json'), content: JSON.stringify(capture.routes, null, 2) + '\n' });
  writeScrubbed(outputs, loadIdentity(values.identity));
}

async function recordSnapshot(values: Record<string, string | undefined>): Promise<void> {
  const url = required('--url', values.url);
  const out = resolve(required('--out', values.out));
  const html = await withHeadlessPage(async (page) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    return captureSnapshot(page, values.keep ?? DEFAULT_KEEP);
  });
  writeScrubbed([{ path: out, content: html }], loadIdentity(values.identity));
}

/** A aba que o dono está olhando: a visível; na falta, a última aberta. */
async function activePage(pages: Page[]): Promise<Page | null> {
  for (const page of pages) {
    if (page.isClosed()) continue;
    if (await page.evaluate('document.visibilityState === "visible"').catch(() => false)) return page;
  }
  return pages.filter((p) => !p.isClosed()).at(-1) ?? null;
}

async function recordProfile(values: Record<string, string | undefined>): Promise<void> {
  const staging = outsideRepo('--staging', values.staging);
  const choice = detectBrowserChannel();
  if (!choice) fail('nenhum navegador encontrado: defina APPLY_BROWSER (chrome, msedge ou o caminho de um executável)');
  mkdirSync(staging, { recursive: true });

  const context = await realLaunch(choice, { serviceWorkers: 'block' })(browserProfileDir(applyDataDir()));
  let closed = false;
  try {
    // Só leitura, antes de qualquer outra coisa: nenhuma requisição que não seja GET sai do navegador.
    await blockWrites(context);
    context.on('close', () => { closed = true; });
    const first = context.pages()[0] ?? (await context.newPage());
    await blockSubmitClicks(first, { closeUnscriptable: true });
    if (!context.pages().length) await context.newPage();
    // Não se faz login neste modo: a sessão precisa já existir no perfil.
    if (!hasSessionCookie(await context.cookies('https://www.linkedin.com'), 'li_at', 'linkedin.com')) {
      fail('o perfil não tem sessão aberta no LinkedIn (sem o cookie de sessão). Abra o navegador, entre no LinkedIn normalmente, feche-o e rode de novo.');
    }
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }

  console.log('Navegue até a página e digite um nome de arquivo para gravá-la (sem limpeza) em', staging);
  console.log('Linha vazia encerra.');
  const lines = createInterface({ input: process.stdin });
  try {
    for await (const raw of lines) {
      const name = raw.trim();
      if (!name || closed) break;
      const page = await activePage(context.pages());
      if (!page) { console.error('nenhuma aba aberta'); continue; }
      try {
        const html = await captureSnapshot(page);
        const file = join(staging, `${name.replace(/[^\w.-]+/g, '_').replace(/\.html$/i, '')}.html`);
        writeFileSync(file, html, 'utf8');
        console.log('gravado', file);
      } catch (err) {
        console.error('não gravou:', err instanceof Error ? err.message : err);
      }
    }
  } finally {
    lines.close();
    if (!closed) await context.close().catch(() => {});
  }
}

function listRecorded(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listRecorded(full, base);
    return RECORDED.test(entry.name) ? [relative(base, full)] : [];
  });
}

function scrubStaging(values: Record<string, string | undefined>): void {
  const from = outsideRepo('--from', values.from);
  const to = resolve(required('--to', values.to));
  const identity = loadIdentity(values.identity);
  const files = listRecorded(from);
  if (!files.length) fail(`nenhum .html, .json, .js ou .css em ${from}`);
  writeScrubbed(files.map((f) => ({ path: join(to, f), content: readFileSync(join(from, f)) })), identity);
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  if (!mode || !['json', 'replay', 'snapshot', 'profile', 'scrub'].includes(mode)) {
    console.error(USAGE);
    process.exit(1);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      url: { type: 'string' }, out: { type: 'string' }, keep: { type: 'string' }, staging: { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' }, identity: { type: 'string' },
    },
    strict: true,
  });
  if (mode === 'json') await recordJson(values);
  else if (mode === 'replay') await recordReplay(values);
  else if (mode === 'snapshot') await recordSnapshot(values);
  else if (mode === 'profile') await recordProfile(values);
  else scrubStaging(values);
}

main().catch((err) => {
  console.error(err instanceof UsageError ? `${err.message}\n\n${USAGE}` : err);
  process.exit(1);
});
