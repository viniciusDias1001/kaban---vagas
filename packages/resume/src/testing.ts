import { strToU8, zipSync } from 'fflate';
import PDFDocument from 'pdfkit';
import type { TailoredResume } from '@kv/shared';

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

/** Currículo adaptado fictício, já com os campos do modelo, para os testes do texto e do PDF. */
export const SAMPLE_TAILORED: TailoredResume = {
  lang: 'pt-BR',
  contact: { name: 'Maria Exemplo da Silva', email: 'maria@exemplo.test', phone: '+55 11 90000-0000', location: 'São Paulo, SP' },
  headline: 'Desenvolvedora Front-end Sênior',
  summary: 'Pessoa fictícia para testes: desenvolvedora front-end com foco em React.',
  experiences: [
    { id: 'exp_ccccccc1', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora Front-end Sênior', start: '2021-03', end: '', location: 'Remoto',
      section: 'principal', note: 'Antes: Desenvolvedora Pleno (2019-2021)',
      achievements: [{ sourceId: 'ach_ccccccc1', text: 'Reduzi o tempo de build em 40% com a migração para Vite' }, { sourceId: 'ach_ccccccc2', text: 'Liderei 3 pessoas no redesenho do checkout' }] },
    { id: 'exp_ccccccc2', company: 'Outra Fictícia SA', title: 'Monitora de Programação', start: '2018', end: '2019-12', location: '',
      section: 'complementar', note: '', achievements: [{ sourceId: 'ach_ccccccc3', text: 'Atendi 40 estudantes por semestre' }] },
  ],
  education: [{ id: 'edu_ccccccc1', institution: 'Universidade Exemplo', degree: 'Ciência da Computação', start: '2015', end: '2019' }],
  skills: [
    { id: 'skill_ccccccc1', name: 'React', group: 'Front-end' }, { id: 'skill_ccccccc2', name: 'Node.js', group: 'Back-end & APIs' },
    { id: 'skill_ccccccc3', name: 'TypeScript', group: 'Front-end' }, { id: 'skill_ccccccc4', name: 'Git', group: '' },
  ],
  languages: [{ id: 'lang_ccccccc1', name: 'Inglês', level: 'avançado' }, { id: 'lang_ccccccc2', name: 'Espanhol', level: '' }],
  certifications: [{ id: 'cert_ccccccc1', name: 'Certificação Fictícia', issuer: 'Instituto Exemplo', date: '2022-05' }],
  links: [{ id: 'link_ccccccc1', label: 'Portfólio', url: 'https://exemplo.test/maria/' }, { id: 'link_ccccccc2', label: 'Rede', url: 'https://www.rede.exemplo.test/in/maria' }],
};
