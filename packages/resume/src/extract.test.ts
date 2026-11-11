import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync, strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@kv/shared';
import { EXTRACT_LIMITS, extractResumeText } from './extract';
import { extractInWorker } from './extract-runner';
import { sniffResume, zipEntries } from './sniff';
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

/**
 * Subir o pdf.js, o mammoth e uma worker thread sob CPU disputada (a suíte inteira em paralelo) leva
 * vários segundos: os 5 s padrão do vitest não bastam. Mesmo teto do `hookTimeout` da raiz.
 */
const SLOW = { timeout: 60_000 };
/** Um processo filho que sobe a worker de verdade três vezes: cada uma com o teto de partida (60 s) mais o de leitura (15 s). */
const REAL_WORKER = { timeout: 240_000 };

const MB = 1024 * 1024;
const CONTENT_TYPES = strToU8(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
);
const RELS = strToU8(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
);
const documentXml = (text: string) =>
  `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

/** DOCX cujo `word/document.xml` tem um único parágrafo com `megabytes` MiB da letra A. Gerado aqui: nada é commitado. */
function bombDocx(megabytes: number, extra: Record<string, Uint8Array> = {}): Uint8Array {
  const [head, tail] = documentXml('|').split('|').map((part) => strToU8(part));
  const xml = new Uint8Array(head.length + megabytes * MB + tail.length).fill(0x41);
  xml.set(head, 0);
  xml.set(tail, xml.length - tail.length);
  return zipSync({ '[Content_Types].xml': CONTENT_TYPES, '_rels/.rels': RELS, 'word/document.xml': xml, ...extra }, { level: 6 });
}

/** Reescreve o tamanho descompactado declarado de uma entrada, no índice central e no cabeçalho local. */
function lieAboutSize(zip: Uint8Array, name: string, declared: number): Uint8Array {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer);
  const wanted = strToU8(name);
  for (let i = 0; i + 46 < out.length; i++) {
    const signature = view.getUint32(i, true);
    const central = signature === 0x02014b50;
    if (!central && signature !== 0x04034b50) continue;
    const nameLength = view.getUint16(i + (central ? 28 : 26), true);
    const nameAt = i + (central ? 46 : 30);
    if (nameLength === wanted.length && wanted.every((byte, k) => out[nameAt + k] === byte)) view.setUint32(i + (central ? 24 : 22), declared, true);
  }
  return out;
}

/** PDF de uma página cujo conteúdo (um stream Flate pequeno) desenha `megabytes` MiB de texto. */
function hugeTextPdf(megabytes: number): Uint8Array {
  // Cada linha recomeça no mesmo ponto da página: o pdf.js descarta o texto desenhado fora dela.
  const line = strToU8(`ET BT /F1 6 Tf 20 800 Td (${'Maria Exemplo da Silva, pessoa ficticia. '.repeat(4)}) Tj\n`);
  const head = strToU8('BT\n');
  const content = new Uint8Array(megabytes * MB).fill(0x20);
  content.set(head);
  for (let at = head.length; at + line.length + 3 < content.length; at += line.length) content.set(line, at);
  content.set(strToU8('ET\n'), content.length - 3);
  const deflated = deflateSync(content, { level: 6 });
  // Invólucro zlib: 2 bytes de cabeçalho; o Adler-32 do fim não é conferido pelo pdf.js.
  const stream = new Uint8Array(deflated.length + 6);
  stream.set([0x78, 0x9c]);
  stream.set(deflated, 2);

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === 'string' ? strToU8(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (body: () => void) => {
    offsets.push(length);
    push(`${offsets.length} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  push('%PDF-1.4\n');
  object(() => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(() => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  object(() => push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'));
  object(() => {
    push(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`);
    push(stream);
    push('\nendstream');
  });
  object(() => push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

describe('sniffResume', SLOW, () => {
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

describe('extractResumeText', SLOW, () => {
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

  it('refuses a docx whose text parts inflate past the cap', async () => {
    expect(await extractResumeText(bombDocx(64), 'docx')).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('refuses a decompression bomb that lies about its sizes, without inflating it whole', async () => {
    const bomb = lieAboutSize(bombDocx(96), 'word/document.xml', 1000);
    // O índice do ZIP jura que o arquivo é minúsculo.
    expect(zipEntries(bomb).reduce((sum, e) => sum + e.size, 0)).toBeLessThan(10_000);
    expect(bomb.length).toBeLessThan(MB);
    const before = process.memoryUsage().arrayBuffers;
    const result = await extractResumeText(bomb, 'docx');
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
    // Nada perto dos 96 MiB foi alocado: o que sobra depois da recusa cabe no teto com folga.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * MB);
  });

  it('never inflates media: an image entry does not count against the cap, whatever size it declares', async () => {
    const image = { 'word/media/image1.png': new Uint8Array(40 * MB) };
    expect(await extractResumeText(bombDocx(1, image), 'docx')).toMatchObject({ ok: true });
    expect(await extractResumeText(lieAboutSize(bombDocx(1, image), 'word/media/image1.png', 10), 'docx')).toMatchObject({ ok: true });
  });

  it('reads a docx stored without compression and refuses one with corrupted data', async () => {
    const oneLine = TEXT.replaceAll('\n', ' ');
    const parts = { '[Content_Types].xml': CONTENT_TYPES, '_rels/.rels': RELS, 'word/document.xml': strToU8(documentXml(oneLine)) };
    expect(await extractResumeText(zipSync(parts, { level: 0 }), 'docx')).toEqual({ ok: true, text: oneLine });

    const corrupted = zipSync(parts, { level: 6 });
    // Estraga os dados compactados da primeira entrada; o índice continua íntegro.
    corrupted.fill(0xff, 30 + '[Content_Types].xml'.length, 30 + '[Content_Types].xml'.length + 40);
    expect(sniffResume(corrupted)).toBe('docx');
    expect(await extractResumeText(corrupted, 'docx')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('stops reading a pdf page that draws far more text than a resume has', async () => {
    const pdf = hugeTextPdf(12);
    expect(pdf.length).toBeLessThan(MB);
    const result = await extractResumeText(pdf, 'pdf');
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('Maria Exemplo da Silva, pessoa ficticia.') });
    expect(result.ok && result.text.length).toBeLessThanOrEqual(LIMITS.resumeText);
  });
});

describe('extractInWorker', SLOW, () => {
  let dir: string;
  const entry = (name: string, code: string) => {
    const file = join(dir, name);
    writeFileSync(file, code);
    return pathToFileURL(file);
  };
  const HEAD = "import { parentPort, workerData } from 'node:worker_threads';\n";
  const READY = "parentPort.postMessage({ kvExtract: 'ready' });\n";
  const sleep = (ms: number) => `await new Promise((r) => setTimeout(r, ${ms}));\n`;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kv-extract-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns what the worker posts', async () => {
    const ok = entry('ok.mjs', HEAD + 'parentPort.postMessage({ ok: true, text: `${workerData.kind}:${workerData.buf.length}` });\n');
    expect(await extractInWorker(Buffer.from('abc'), 'pdf', { entry: ok })).toEqual({ ok: true, text: 'pdf:3' });
  });

  it('terminates a worker that never finishes and reports a timeout', async () => {
    const hang = entry('hang.mjs', HEAD + READY + 'for (;;) {}\n');
    const started = Date.now();
    const result = await extractInWorker(Buffer.from('abc'), 'pdf', { entry: hang, timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('starts the parse timer only when the worker says it is ready: a slow start is not a timeout', async () => {
    const slowStart = entry('slow-start.mjs', HEAD + sleep(1_500) + READY + "parentPort.postMessage({ ok: true, text: 'pronto' });\n");
    expect(await extractInWorker(Buffer.from('abc'), 'pdf', { entry: slowStart, timeoutMs: 300 })).toEqual({ ok: true, text: 'pronto' });
  });

  it('gives up on a worker that never becomes ready, with a cap of its own', async () => {
    const neverReady = entry('never-ready.mjs', 'for (;;) {}\n');
    const result = await extractInWorker(Buffer.from('abc'), 'pdf', { entry: neverReady, timeoutMs: 60_000, startupTimeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('reports an invalid file when the worker crashes, exits without answering or posts garbage', async () => {
    const crash = entry('crash.mjs', "throw new Error('parser explodiu');\n");
    expect(await extractInWorker(Buffer.from('abc'), 'docx', { entry: crash })).toMatchObject({ ok: false, reason: 'invalid' });
    const silent = entry('silent.mjs', '\n');
    expect(await extractInWorker(Buffer.from('abc'), 'docx', { entry: silent })).toMatchObject({ ok: false, reason: 'invalid' });
    const garbage = entry('garbage.mjs', HEAD + "parentPort.postMessage('qualquer coisa');\n");
    expect(await extractInWorker(Buffer.from('abc'), 'docx', { entry: garbage })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('runs one extraction at a time, queueing the rest', async () => {
    const timed = entry(
      'timed.mjs',
      HEAD + READY + 'const start = Date.now();\n' + sleep(250) + 'parentPort.postMessage({ ok: true, text: `${start}-${Date.now()}` });\n',
    );
    const results = await Promise.all(Array.from({ length: 4 }, () => extractInWorker(Buffer.from('abc'), 'pdf', { entry: timed })));
    const spans = results.map((r) => (r.ok ? r.text.split('-').map(Number) : [NaN, NaN]));
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i][0], `extraction ${i} started before extraction ${i - 1} ended`).toBeGreaterThanOrEqual(spans[i - 1][1]);
    }
  });

  it('terminates a worker that makes the process memory grow past the cap', async () => {
    // Memória fora do heap do V8 (ArrayBuffer): o `maxOldGenerationSizeMb` da worker não a enxerga.
    const hog = entry(
      'hog.mjs',
      HEAD + READY + `const kept = [];\nfor (let i = 0; i < 40; i++) {\n  kept.push(Buffer.alloc(16 * 1024 * 1024, 1));\n  ${sleep(20)}}\n` + sleep(60_000),
    );
    const started = Date.now();
    const result = await extractInWorker(Buffer.from('abc'), 'docx', { entry: hog, maxRssGrowthMb: 96, timeoutMs: 45_000 });
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
    expect(Date.now() - started).toBeLessThan(40_000);
  });
});

describe('extractInWorker with the real worker', REAL_WORKER, () => {
  // A worker de verdade é um .ts que só carrega sob o tsx, como a API e o worker em produção
  // (`node --import tsx`); o vitest não repassa isso às threads. Por isso um processo filho, que de
  // quebra prova que nada da extração segura o processo vivo: ele tem de terminar sozinho.
  it('extracts a pdf and a docx, refuses the lying bomb and lets the process exit on its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-extract-real-'));
    try {
      writeFileSync(join(dir, 'cv.pdf'), await makeTextPdf(TEXT));
      writeFileSync(join(dir, 'cv.docx'), makeDocx(TEXT));
      writeFileSync(join(dir, 'bomb.docx'), lieAboutSize(bombDocx(96), 'word/document.xml', 1000));
      writeFileSync(
        join(dir, 'run.mjs'),
        "import { readFileSync } from 'node:fs';\n" +
          'const [pkg, ...files] = process.argv.slice(2);\n' +
          'const { extractInWorker } = await import(pkg);\n' +
          "const read = (file) => extractInWorker(readFileSync(file), file.endsWith('.pdf') ? 'pdf' : 'docx');\n" +
          '// As três de uma vez: a fila do pacote é que as põe uma atrás da outra.\n' +
          'console.log(JSON.stringify(await Promise.all(files.map(read))));\n',
      );
      const tsx = pathToFileURL(createRequire(new URL('../../../package.json', import.meta.url)).resolve('tsx')).href;
      const child = spawn(
        process.execPath,
        ['--import', tsx, join(dir, 'run.mjs'), new URL('./index.ts', import.meta.url).href, ...['cv.pdf', 'cv.docx', 'bomb.docx'].map((f) => join(dir, f))],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const code = await new Promise((resolve) => child.on('close', resolve));
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual([
        { ok: true, text: TEXT },
        { ok: true, text: expect.stringContaining('Maria Exemplo da Silva') },
        { ok: false, reason: 'too_large', message: expect.any(String) },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
