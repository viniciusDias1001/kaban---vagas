import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ResumeLang } from '@kv/shared';

/** Nome do arquivo gravado pela prévia, por idioma. */
export const PREVIEW_FILES: Record<ResumeLang, string> = { 'pt-BR': 'curriculo-pt-BR.pdf', en: 'resume-en.pdf' };

/** Pasta de saída: `requested`, ou `<tmp>/kanban-vagas-preview`. Lança se o resultado cair dentro de `repoRoot`. */
export function previewDir(requested: string | undefined, repoRoot: string, tmp: string): string {
  const dir = resolve(requested ?? resolve(tmp, 'kanban-vagas-preview'));
  const rel = relative(resolve(repoRoot), dir);
  // `relative` também resolve a diferença de caixa no Windows; outra unidade devolve um caminho absoluto.
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (inside) throw new Error(`A pasta de saída da prévia deve ficar fora do repositório (${dir}).`);
  return dir;
}
