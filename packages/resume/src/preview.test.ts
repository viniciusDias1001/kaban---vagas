import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREVIEW_FILES, previewDir } from './preview';

describe('previewDir', () => {
  it('defaults to a folder under the temp dir and accepts a folder outside the repository', () => {
    expect(previewDir(undefined, '/repo', '/tmp')).toBe(resolve('/tmp', 'kanban-vagas-preview'));
    expect(previewDir('/home/eu/saida', '/repo', '/tmp')).toBe(resolve('/home/eu/saida'));
    expect(previewDir('/repo-vizinho', '/repo', '/tmp')).toBe(resolve('/repo-vizinho')); // prefixo parecido não é "dentro"
  });
  it('refuses any folder inside the repository', () => {
    for (const inside of ['/repo', '/repo/out', '/repo/docs/../out']) expect(() => previewDir(inside, '/repo', '/tmp')).toThrow(/fora do repositório/);
    expect(() => previewDir(undefined, '/repo', '/repo/tmp')).toThrow(/fora do repositório/);
  });
  it('resolves a relative folder against the repository root, not the working directory', () => {
    expect(() => previewDir('out', '/repo', '/tmp')).toThrow(/fora do repositório/);
    expect(() => previewDir('../repo/out', '/repo', '/tmp')).toThrow(/fora do repositório/);
    expect(previewDir('../saida', '/repo', '/tmp')).toBe(resolve('/repo', '../saida'));
  });
  it.runIf(process.platform === 'win32')('ignores the case of the drive letter and of the folder names on Windows', () => {
    expect(() => previewDir('c:\\repo\\out', 'C:\\Repo', 'D:\\tmp')).toThrow(/fora do repositório/);
    expect(() => previewDir('C:\\REPO', 'c:\\repo', 'D:\\tmp')).toThrow(/fora do repositório/);
    expect(previewDir('d:\\saida', 'C:\\repo', 'D:\\tmp')).toBe(resolve('d:\\saida')); // outra unidade
  });
  it('names one file per language', () => {
    expect(PREVIEW_FILES).toEqual({ 'pt-BR': 'curriculo-pt-BR.pdf', en: 'resume-en.pdf' });
  });
});
