import PDFDocument from 'pdfkit';
import type { ResumeLang, TailoredResume } from '@kv/shared';
import { allFaces, layoutLine, MAX_TOKEN_CHARS, sanitizePdfText, type Run, type Weight } from './pdf-text';

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

/** Limites do renderizador, independentes da validação feita antes dele. */
export const PDF_LIMITS = {
  /** Soma de todos os textos do currículo. Um currículo de dez páginas tem uns 40 mil caracteres. */
  maxChars: 100_000,
  /** Sequência sem espaços acima disto é desenhada em pedaços (não é recusada nem alterada). */
  maxTokenChars: MAX_TOKEN_CHARS,
} as const;

export type ResumePdfErrorCode = 'unsupported_characters' | 'too_long';

/**
 * O currículo não pode virar PDF do jeito que está. `message` é para o usuário (pt-BR).
 * - `unsupported_characters`: há caracteres sem glifo nas fontes embutidas; `characters` lista cada um.
 *   Gerar o PDF mesmo assim faria esses caracteres sumirem do texto sem aviso.
 * - `too_long`: o texto passa de `PDF_LIMITS.maxChars`.
 */
export class ResumePdfError extends Error {
  readonly code: ResumePdfErrorCode;
  /** Caracteres sem glifo, sem repetição, na ordem em que aparecem. Vazio para `too_long`. */
  readonly characters: string[];

  constructor(code: ResumePdfErrorCode, message: string, characters: string[] = []) {
    super(message);
    this.name = 'ResumePdfError';
    this.code = code;
    this.characters = characters;
  }
}

type Step =
  | { kind: 'gap'; lines: number }
  | { kind: 'text'; text: string; weight: Weight; size: number; color: string; lineGap?: number };

/** O documento como uma lista de passos, com os textos ainda crus. Nada é desenhado aqui. */
function plan(resume: TailoredResume): { title: string; author: string; steps: Step[] } {
  const t = LABELS[resume.lang];
  const steps: Step[] = [];
  const gap = (lines: number) => steps.push({ kind: 'gap', lines });
  const text = (value: string, weight: Weight, size: number, color: string, lineGap?: number) =>
    steps.push({ kind: 'text', text: value, weight, size, color, lineGap });
  const heading = (label: string) => {
    gap(0.9);
    text(label.toUpperCase(), 'bold', 12, INK);
    gap(0.25);
  };
  const body = (value: string) => text(value, 'regular', 10, INK, 2);
  const period = (start: string, end: string) => join([start, start || end ? end || t.current : ''], ' - ');

  text(resume.contact.name, 'bold', 18, INK);
  const contact = join([resume.contact.email, resume.contact.phone, resume.contact.location], ' | ');
  if (contact) {
    gap(0.2);
    text(contact, 'regular', 10, MUTED);
  }

  if (resume.summary) {
    heading(t.summary);
    body(resume.summary);
  }
  if (resume.experiences.length > 0) {
    heading(t.experience);
    resume.experiences.forEach((e, i) => {
      if (i > 0) gap(0.6);
      text(join([e.title, e.company], ' - '), 'bold', 11, INK);
      const meta = join([period(e.start, e.end), e.location], ' | ');
      if (meta) text(meta, 'regular', 9, MUTED);
      gap(0.15);
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
  return { title: `${resume.contact.name} - ${resume.lang === 'en' ? 'Resume' : 'Currículo'}`, author: resume.contact.name, steps };
}

type Drawable = { kind: 'gap'; lines: number } | { kind: 'text'; lines: Run[][]; weight: Weight; size: number; color: string; lineGap?: number };

/**
 * Confere o currículo inteiro antes de desenhar qualquer coisa: tamanho total, saneamento de cada texto
 * e cobertura de glifos. Devolve os passos prontos e os caracteres que nenhuma fonte embutida desenha.
 */
function prepare(resume: TailoredResume): { title: string; author: string; steps: Drawable[]; missing: string[] } {
  const { title, author, steps } = plan(resume);
  const total = steps.reduce((sum, step) => sum + (step.kind === 'text' ? step.text.length : 0), 0);
  if (total > PDF_LIMITS.maxChars) {
    throw new ResumePdfError(
      'too_long',
      `O currículo tem texto demais para virar PDF (${total} caracteres; o limite é ${PDF_LIMITS.maxChars}). Encurte o resumo e as realizações.`,
    );
  }
  const missing = new Set<string>();
  const drawable = steps.map((step): Drawable => {
    if (step.kind === 'gap') return step;
    const lines = sanitizePdfText(step.text).split('\n').map((line) => layoutLine(line, step.weight, missing));
    return { ...step, lines };
  });
  const oneLine = (value: string) => {
    const runs = sanitizePdfText(value).split('\n').map((line) => layoutLine(line, 'regular', new Set()));
    return runs.map((line) => line.map((run) => run.text).join('')).join(' ');
  };
  return { title: oneLine(title), author: oneLine(author), steps: drawable, missing: [...missing] };
}

const describe = (char: string) => `"${char}" (U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`;

function unsupported(characters: string[]): ResumePdfError {
  const shown = characters.slice(0, 20).map(describe).join(', ');
  const more = characters.length > 20 ? ` e mais ${characters.length - 20}` : '';
  return new ResumePdfError(
    'unsupported_characters',
    `O PDF não pode ser gerado: a fonte do documento não tem ${characters.length === 1 ? 'o caractere' : 'os caracteres'} ${shown}${more}. ` +
      'Edite o currículo e troque ou remova esses caracteres.',
    characters,
  );
}

/**
 * Caracteres do currículo que nenhuma fonte embutida desenha (vazio = pode gerar o PDF). Serve para avisar
 * o usuário ao salvar, antes de ele pedir o PDF. Lança `ResumePdfError` (`too_long`) se o texto passa do teto.
 */
export function unsupportedPdfCharacters(resume: TailoredResume): string[] {
  return prepare(resume).missing;
}

/**
 * PDF do currículo adaptado, feito para sistemas de triagem (ATS): uma coluna, texto real e selecionável
 * na ordem de leitura, sem tabelas, sem imagens, sem cabeçalho ou rodapé. Recebe o conteúdo já revisado.
 *
 * Fontes: Noto Serif latino, latino estendido, vietnamita, cirílico e grego, trocadas por trecho conforme
 * o texto pede. Nenhum caractere some em silêncio: se algum não tem glifo (CJK, árabe, emoji, "✓"...), a
 * promessa rejeita com `ResumePdfError` (`unsupported_characters`) dizendo quais. Também rejeita
 * (`too_long`) acima de `PDF_LIMITS.maxChars`. Caracteres de controle e invisíveis são descartados.
 */
export function renderResumePdf(resume: TailoredResume): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { title, author, steps, missing } = prepare(resume);
    if (missing.length > 0) throw unsupported(missing);

    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title, Author: author } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const face of allFaces()) doc.registerFont(face.name, face.path);

    for (const step of steps) {
      if (step.kind === 'gap') {
        doc.moveDown(step.lines);
        continue;
      }
      const options = step.lineGap === undefined ? {} : { lineGap: step.lineGap };
      doc.fontSize(step.size).fillColor(step.color);
      step.lines.forEach((runs, i) => {
        // Linha em branco no meio do texto ocupa uma linha; no fim, nada (como o pdfkit faz com "\n").
        if (runs.length === 0) {
          if (i < step.lines.length - 1) doc.font(`${step.weight}-latin`).text(' ', options);
          return;
        }
        runs.forEach((run, k) => doc.font(run.font).text(run.text, { ...options, continued: k < runs.length - 1 }));
      });
    }
    doc.end();
  });
}
