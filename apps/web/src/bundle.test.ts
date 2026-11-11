import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guarda contra o Zod voltar ao bundle do navegador: percorre estaticamente o grafo de imports de
 * execução a partir de `main.tsx` (imports estáticos e `import()` dinâmicos; `import type`/`export type`
 * são apagados no build e ignorados) e falha se alcançar `zod`, `schemas.ts` ou a entrada principal de
 * `@kv/shared`. O web deve importar de `@kv/shared/client`. (Zod no navegador soma ~85 kB e o teste
 * `new Function("")` dele viola a CSP da API.)
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const SHARED_SRC = resolve(SRC, '../../../packages/shared/src');
const ENTRY = resolve(SRC, 'main.tsx');
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Especificadores que o código gerado manteria (fora imports/exports só de tipo). */
function runtimeSpecifiers(code: string): string[] {
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const found: string[] = [];
  // import|export [type] ... from 'x'  /  import 'x'  /  import('x')
  const re = /\b(import|export)\s+(type\s+)?(?:([\w*${}\s,]+?)\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of noComments.matchAll(re)) {
    if (m[5]) {
      found.push(m[5]);
      continue;
    }
    if (m[2]) continue; // import type / export type
    const clause = m[3];
    // `import { type A, type B } from 'x'`: sem valores, nada sobra no bundle
    if (clause && /^\{[^}]*\}$/.test(clause.trim())) {
      const names = clause.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    found.push(m[4]);
  }
  return found;
}

function resolveLocal(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = resolve(SRC, spec.slice(2));
  else if (spec === '@kv/shared/client') base = resolve(SHARED_SRC, 'client');
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const ext of EXTENSIONS) {
    const file = base + ext;
    if (/\.(tsx?|jsx?)$/.test(file) && existsSync(file)) return file;
  }
  return null; // css, svg, etc.: não carregam Zod
}

function walk(entry: string) {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec === 'zod' || spec.startsWith('zod/') || spec === '@kv/shared') {
        offenders.push(`${file} -> ${spec}`);
        continue;
      }
      const next = resolveLocal(spec, file);
      if (!next) continue;
      if (/[\/]schemas\.ts$/.test(next)) offenders.push(`${file} -> ${spec}`);
      else stack.push(next);
    }
  }
  return { seen, offenders };
}

describe('bundle do navegador', () => {
  it('não alcança o Zod nem os schemas de @kv/shared em tempo de execução', () => {
    const { seen, offenders } = walk(ENTRY);
    expect(seen.size).toBeGreaterThan(10); // o percurso de fato andou pelo app
    expect([...seen].some((f) => f.endsWith('constants.ts'))).toBe(true); // e chegou nas constantes
    expect(offenders).toEqual([]);
  });

  it('detecta um import de runtime da entrada principal (o próprio guarda funciona)', () => {
    expect(runtimeSpecifiers("import { COLUMNS } from '@kv/shared';")).toEqual(['@kv/shared']);
    expect(runtimeSpecifiers("import type { Column } from '@kv/shared';")).toEqual([]);
    expect(runtimeSpecifiers("import { type Column } from '@kv/shared';")).toEqual([]);
    expect(runtimeSpecifiers("const m = import('zod');")).toEqual(['zod']);
  });
});
