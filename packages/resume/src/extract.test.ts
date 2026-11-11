import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, extractResumeText } from './extract';
import { extractInWorker } from './extract-runner';
import { sniffResume } from './sniff';
import { makeDocx, makeImageOnlyPdf, makeLongPdf, makePlainZip, makeTextPdf } from './testing';

/** Pessoa fictícia. O mesmo formato de SAMPLE_RESUME_TEXT (@kv/ai/testing). */
const TEXT = [
  'Maria Exemplo da Silva',
  'Pessoa fictícia para testes: desenvolvedora front-end com foco em React.',
  'maria@exemplo.test • São Paulo, SP',
  'Experiência',
  'Desenvolvedora Front-end | Empresa Fictícia Ltda | 2021-03 | 2024-06',
  '- Reduzi o tempo de build em 40% com a migração para Vite',
  'Habilidades',
  'React, TypeScript, Node',
].join('\n');

describe('sniffResume', () => {
  it('identifies pdf and docx by content, whatever the file is called', async () => {
    expect(sniffResume(await makeTextPdf(TEXT))).toBe('pdf');
    expect(sniffResume(makeDocx(TEXT))).toBe('docx');
  });

  it('refuses everything else: plain zip, text, html, an empty file and a truncated zip', () => {
    expect(sniffResume(makePlainZip())).toBeNull();
    expect(sniffResume(Buffer.from('Maria Exemplo da Silva\nCurrículo em texto puro'))).toBeNull();
    expect(sniffResume(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffResume(Buffer.alloc(0))).toBeNull();
    expect(sniffResume(makeDocx(TEXT).subarray(0, 40))).toBeNull();
  });
});

describe('extractResumeText', () => {
  it('extracts the text of a pdf, keeping lines and portuguese accents', async () => {
    const result = await extractResumeText(await makeTextPdf(TEXT), 'pdf');
    expect(result).toEqual({ ok: true, text: TEXT });
  });

  it('extracts the text of a docx', async () => {
    const result = await extractResumeText(makeDocx(TEXT), 'docx');
    expect(result.ok && result.text.split('\n').filter(Boolean)).toEqual(TEXT.split('\n'));
  });

  it('refuses an image-only pdf with a clear message', async () => {
    const result = await extractResumeText(await makeImageOnlyPdf(), 'pdf');
    expect(result).toEqual({ ok: false, reason: 'no_text', message: expect.stringContaining('não tem texto extraível') });
  });

  it('refuses a pdf above the page limit', async () => {
    const result = await extractResumeText(await makeLongPdf(EXTRACT_LIMITS.maxPages + 1), 'pdf');
    expect(result).toMatchObject({ ok: false, reason: 'too_many_pages' });
  });

  it('never throws on garbage: reports an invalid file', async () => {
    expect(await extractResumeText(Buffer.from('%PDF-1.7 lixo sem estrutura'), 'pdf')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await extractResumeText(makePlainZip(), 'docx')).toMatchObject({ ok: false });
    expect(await extractResumeText(Buffer.from('lixo'), 'docx')).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('extractInWorker', () => {
  let dir: string;
  const entry = (name: string, code: string) => {
    const file = join(dir, name);
    writeFileSync(file, code);
    return pathToFileURL(file);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kv-extract-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns what the worker posts', async () => {
    const ok = entry(
      'ok.mjs',
      "import { parentPort, workerData } from 'node:worker_threads';\n" +
        "parentPort.postMessage({ ok: true, text: `${workerData.kind}:${workerData.buf.length}` });\n",
    );
    expect(await extractInWorker(Buffer.from('abc'), 'pdf', { entry: ok })).toEqual({ ok: true, text: 'pdf:3' });
  });

  it('terminates a worker that never finishes and reports a timeout', async () => {
    const hang = entry('hang.mjs', 'for (;;) {}\n');
    const started = Date.now();
    const result = await extractInWorker(Buffer.from('abc'), 'pdf', { entry: hang, timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports an invalid file when the worker crashes or exits without answering', async () => {
    const crash = entry('crash.mjs', "throw new Error('parser explodiu');\n");
    expect(await extractInWorker(Buffer.from('abc'), 'docx', { entry: crash })).toMatchObject({ ok: false, reason: 'invalid' });
    const silent = entry('silent.mjs', '\n');
    expect(await extractInWorker(Buffer.from('abc'), 'docx', { entry: silent })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
