import { strToU8, zipSync } from 'fflate';
import PDFDocument from 'pdfkit';

/**
 * Arquivos de exemplo gerados em código, para testes unitários e e2e. Nenhum binário é commitado e
 * nenhum currículo real é usado: passe sempre um texto de pessoa fictícia (ex.: SAMPLE_RESUME_TEXT de
 * @kv/ai/testing).
 */

function pdf(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

/** PDF de texto, uma linha por parágrafo. Usa a Helvetica embutida do PDF (cobre os acentos do português). */
export function makeTextPdf(text: string): Promise<Buffer> {
  return pdf((doc) => {
    doc.fontSize(11);
    for (const line of text.split('\n')) doc.text(line);
  });
}

/** PNG de 1x1 pixel. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** PDF de uma página só com uma imagem, como um currículo escaneado: não tem texto extraível. */
export function makeImageOnlyPdf(): Promise<Buffer> {
  return pdf((doc) => {
    doc.image(PIXEL, 50, 50, { width: 400, height: 500 });
  });
}

/** PDF de texto com `pages` páginas. */
export function makeLongPdf(pages: number): Promise<Buffer> {
  return pdf((doc) => {
    for (let i = 0; i < pages; i++) {
      if (i > 0) doc.addPage();
      doc.text(`Página ${i + 1} de um documento fictício longo demais para ser um currículo.`);
    }
  });
}

const xml = (body: string) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`);
const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** DOCX mínimo (três partes), um parágrafo por linha. */
export function makeDocx(text: string): Buffer {
  const paragraphs = text
    .split('\n')
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join('');
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': xml(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      ),
      '_rels/.rels': xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ),
      'word/document.xml': xml(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
      ),
    }),
  );
}

/** Um ZIP comum, que não é DOCX. */
export function makePlainZip(): Buffer {
  return Buffer.from(zipSync({ 'leia-me.txt': strToU8('não é um currículo') }));
}
