/** Ajudantes dos testes de roteiro. Só os testes importam este arquivo. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import type { ResolvedAnswer } from '@kv/shared';
import type { ApplyJob } from '../types';

const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures', import.meta.url));

/** Caminho absoluto de um arquivo em `packages/apply/fixtures/<site>/`. */
export function fixturePath(site: string, file: string): string {
  return resolve(FIXTURES_DIR, site, file);
}

/** Lê `<capture>/routes.json` (URL → arquivo) de uma gravação `replay`; os valores saem absolutos. */
export function replayRoutes(site: string, capture: string): Record<string, string> {
  const routes = JSON.parse(readFileSync(fixturePath(site, join(capture, 'routes.json')), 'utf8')) as Record<string, string>;
  return Object.fromEntries(Object.entries(routes).map(([url, file]) => [url, fixturePath(site, join(capture, file))]));
}

export function job(over: Partial<ApplyJob> = {}): ApplyJob {
  return { id: 1, source: 'greenhouse', url: '', externalId: '', company: 'Acme', title: 'Dev', ...over };
}

export function ans(questionId: string, value: ResolvedAnswer['value']): ResolvedAnswer {
  return { questionId, value, source: 'rule', category: 'identity', basis: [], bankAnswerId: null };
}

/** PDF mínimo de uma página em branco, montado em código, na pasta temporária. */
export function fakeResumePath(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const dir = join(tmpdir(), 'kv-apply-fixtures');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'curriculo-teste.pdf');
  writeFileSync(file, pdf, 'latin1');
  return file;
}

/** URL de cada requisição que não é GET, à medida que acontece. */
export function watchWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url());
  });
  return writes;
}

const CLICKABLE = `'button, a, [role="button"], input[type="submit"], input[type="button"]'`;
const textOfSource = `(el) => (el.textContent || el.value || (el.getAttribute && el.getAttribute('aria-label')) || '').replace(/\s+/g, ' ').trim()`;

let bindings = 0;

/**
 * Texto de cada botão ou link clicado. Sobrevive a navegações. A escuta fica na janela, na fase de captura, para
 * rodar antes de qualquer tratador da página e antes do de `linkSteps`.
 */
export async function watchClicks(page: Page): Promise<string[]> {
  const clicks: string[] = [];
  const name = `__applyWatchClick${bindings++}`;
  await page.exposeBinding(name, (_source, text: string) => {
    clicks.push(text);
  });
  const install = `(() => {
    const textOf = ${textOfSource};
    window.addEventListener('click', (e) => {
      const el = e.target && e.target.closest && e.target.closest(${CLICKABLE});
      if (el) window[${JSON.stringify(name)}](textOf(el));
    }, true);
  })()`;
  await page.addInitScript(install);
  await page.evaluate(install).catch(() => {});
  return clicks;
}

/**
 * Um `snapshot` não tem comportamento: na página `from`, o clique em um botão cujo texto casa com `button` leva a
 * página para `to` (que precisa estar nas rotas), no lugar do que o JavaScript do site faria. Barra os tratadores
 * da própria página, mas não impede `watchClicks` de registrar o clique.
 */
export async function linkSteps(page: Page, links: Array<{ from: string; button: RegExp; to: string }>): Promise<void> {
  const name = `__applyGo${bindings++}`;
  await page.exposeBinding(name, (_source, to: string) => {
    void page.goto(to).catch(() => {});
  });
  const rules = links.map((l) => ({ from: l.from, source: l.button.source, flags: l.button.flags, to: l.to }));
  const install = `(() => {
    const rules = ${JSON.stringify(rules)};
    const textOf = ${textOfSource};
    const bare = (u) => u.split('#')[0];
    const here = () => bare(location.href);
    const onPage = (from) => here() === bare(from) || (!from.includes('?') && here().split('?')[0] === bare(from));
    document.addEventListener('click', (e) => {
      const el = e.target && e.target.closest && e.target.closest(${CLICKABLE});
      if (!el) return;
      const text = textOf(el);
      const rule = rules.find((r) => onPage(r.from) && new RegExp(r.source, r.flags).test(text));
      if (!rule) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window[${JSON.stringify(name)}](rule.to);
    }, true);
  })()`;
  await page.addInitScript(install);
  await page.evaluate(install).catch(() => {});
}

/** Acrescenta HTML ao começo de `main`, ou do `body` se não houver `main`. */
export async function inject(page: Page, html: string): Promise<void> {
  await page.evaluate(
    `(() => { (document.querySelector('main') || document.body).insertAdjacentHTML('afterbegin', ${JSON.stringify(html)}); })()`,
  );
}
