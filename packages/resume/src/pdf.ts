import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import type { ResumeLang, TailoredResume } from '@kv/shared';

const require = createRequire(import.meta.url);
/**
 * Noto Sans (OFL-1.1), subconjunto latino: cobre todos os acentos do português e a pontuação tipográfica.
 * O pdfkit embute só os glifos usados. Caracteres fora do latino (cirílico, CJK) não têm glifo nesta fonte.
 */
const FONT = {
  regular: require.resolve('@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'),
  bold: require.resolve('@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff'),
};

const LABELS: Record<ResumeLang, Record<'summary' | 'experience' | 'education' | 'skills' | 'languages' | 'certifications' | 'links' | 'current', string>> = {
  'pt-BR': {
    summary: 'Resumo', experience: 'Experiência', education: 'Formação', skills: 'Habilidades', languages: 'Idiomas',
    certifications: 'Certificações', links: 'Links', current: 'atual',
  },
  en: {
    summary: 'Summary', experience: 'Experience', education: 'Education', skills: 'Skills', languages: 'Languages',
    certifications: 'Certifications', links: 'Links', current: 'present',
  },
};

const INK = '#111111';
const MUTED = '#555555';
const join = (parts: (string | undefined)[], sep: string) => parts.filter(Boolean).join(sep);

/**
 * PDF do currículo adaptado, feito para sistemas de triagem (ATS): uma coluna, texto real e selecionável
 * na ordem de leitura, sem tabelas, sem imagens, sem cabeçalho ou rodapé. Recebe o conteúdo já revisado.
 */
export function renderResumePdf(resume: TailoredResume): Promise<Buffer> {
  const t = LABELS[resume.lang];
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: `${resume.contact.name} - ${resume.lang === 'en' ? 'Resume' : 'Currículo'}`, Author: resume.contact.name },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('regular', FONT.regular);
    doc.registerFont('bold', FONT.bold);

    const heading = (label: string) => {
      doc.moveDown(0.9).font('bold').fontSize(12).fillColor(INK).text(label.toUpperCase());
      doc.moveDown(0.25);
    };
    const body = (text: string) => doc.font('regular').fontSize(10).fillColor(INK).text(text, { lineGap: 2 });
    const period = (start: string, end: string) => join([start, start || end ? end || t.current : ''], ' - ');

    doc.font('bold').fontSize(18).fillColor(INK).text(resume.contact.name);
    const contact = join([resume.contact.email, resume.contact.phone, resume.contact.location], ' | ');
    if (contact) doc.moveDown(0.2).font('regular').fontSize(10).fillColor(MUTED).text(contact);

    if (resume.summary) {
      heading(t.summary);
      body(resume.summary);
    }
    if (resume.experiences.length > 0) {
      heading(t.experience);
      resume.experiences.forEach((e, i) => {
        if (i > 0) doc.moveDown(0.6);
        doc.font('bold').fontSize(11).fillColor(INK).text(join([e.title, e.company], ' - '));
        const meta = join([period(e.start, e.end), e.location], ' | ');
        if (meta) doc.font('regular').fontSize(9).fillColor(MUTED).text(meta);
        doc.moveDown(0.15);
        for (const a of e.achievements) body(`• ${a.text}`);
      });
    }
    if (resume.education.length > 0) {
      heading(t.education);
      for (const e of resume.education) body(join([join([e.degree, e.institution], ' - '), period(e.start, e.end)], ' | '));
    }
    if (resume.skills.length > 0) {
      heading(t.skills);
      body(resume.skills.map((k) => k.name).join(', '));
    }
    if (resume.languages.length > 0) {
      heading(t.languages);
      body(resume.languages.map((l) => (l.level ? `${l.name} (${l.level})` : l.name)).join(', '));
    }
    if (resume.certifications.length > 0) {
      heading(t.certifications);
      for (const c of resume.certifications) body(join([c.name, c.issuer, c.date], ' | '));
    }
    if (resume.links.length > 0) {
      heading(t.links);
      for (const l of resume.links) body(join([l.label, l.url], ': '));
    }
    doc.end();
  });
}
